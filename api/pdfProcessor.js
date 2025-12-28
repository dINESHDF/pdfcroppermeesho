const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs').promises;
const pdfParse = require('pdf-parse');

class PDFProcessor {
  // Platform-specific crop coordinates (in points)
  static CROP_PRESETS = {
    flipkart: {
      pageSize: { width: 595, height: 842 }, // A4 in points
      cropBox: {
        // Measured coordinates from working demo
        topLeft: { x: 272, y: 36 },
        bottomRight: { x: 618, y: 589 },
        x: 272,
        y: 253,           // 842 - 589
        width: 346,       // 618 - 272
        height: 553       // 589 - 36
      }
    },
    meesho: { margin: 40 },
    amazon: { margin: 45 },
    citymall: { margin: 35 },
    custom: { margin: 50 }
  };

  static getPlatformPreset(platform) {
    return this.CROP_PRESETS[platform] || this.CROP_PRESETS.custom;
  }

  // Extract SKU from PDF page text using pdf-parse
  static async extractSKUFromPage(pdfBytes, pageNumber) {
    try {
      const data = await pdfParse(pdfBytes, {
        pagerender: (pageData) => {
          if (pageData.pageIndex + 1 === pageNumber) {
            return pageData.getTextContent().then(textContent => {
              let text = '';
              textContent.items.forEach(item => {
                text += item.str + ' ';
              });
              return text;
            });
          }
          return '';
        }
      });

      const text = data.text;
      
      // Multiple patterns to catch SKU
      // Pattern 1: "1 sp_megha red chiku | MFTEXO"
      let skuMatch = text.match(/\d+\s+([a-zA-Z0-9_\s-]+?)\s*\|\s*[A-Z]/i);
      
      // Pattern 2: Look for text between QTY and |
      if (!skuMatch) {
        skuMatch = text.match(/QTY\s+\d+\s+([a-zA-Z0-9_\s-]+?)\s*\|/i);
      }
      
      // Pattern 3: After SKU ID line
      if (!skuMatch) {
        skuMatch = text.match(/SKU ID.*?QTY\s+\d+\s+([a-zA-Z0-9_\s-]+?)\s*\|/is);
      }

      if (skuMatch && skuMatch[1]) {
        const sku = skuMatch[1].trim();
        console.log(`  📋 Page ${pageNumber} SKU: "${sku}"`);
        return sku;
      }
      
      console.log(`  ⚠️ Page ${pageNumber}: No SKU found`);
      return null;
    } catch (error) {
      console.error(`  ⚠️ Page ${pageNumber} SKU extraction error:`, error.message);
      return null;
    }
  }
// Main PDF processing method
static async processPDF(filePaths, settings) {
  try {
    console.log('🔧 Processing with settings:', JSON.stringify(settings, null, 2));
    console.log('📁 Files:', filePaths.length);

    let pdfDoc;

    // ========== STEP 1: MERGE PDFs ==========
    if (settings.mergePdf && filePaths.length > 1) {
      console.log('🔀 Step 1: Merging multiple PDFs...');
      pdfDoc = await PDFDocument.create();
      for (const filePath of filePaths) {
        const pdfBytes = await fs.readFile(filePath);
        const srcDoc = await PDFDocument.load(pdfBytes);
        const pages = await pdfDoc.copyPages(srcDoc, srcDoc.getPageIndices());
        pages.forEach(page => pdfDoc.addPage(page));
      }
      console.log(`✅ Merged ${pdfDoc.getPageCount()} pages from ${filePaths.length} files`);
    } else {
      console.log('📄 Step 1: Loading single PDF...');
      const pdfBytes = await fs.readFile(filePaths[0]);
      pdfDoc = await PDFDocument.load(pdfBytes);
    }

    const preset = this.getPlatformPreset(settings.platform);
    console.log('🎯 Platform:', settings.platform);

    // ========== STEP 2: CROP PDFs ==========
    if (settings.platform === 'flipkart' && preset.cropBox) {
      console.log('✂️ Step 2: Applying Flipkart precise crop...');
      pdfDoc = await this.cropFlipkart(pdfDoc, preset.cropBox);
    } else if (settings.platform !== 'flipkart' && settings.margin && settings.margin !== '0') {
      console.log(`✂️ Step 2: Applying ${settings.margin}px margin crop...`);
      await this.applyMarginCrop(pdfDoc, parseInt(settings.margin));
    } else {
      console.log('⏭️ Step 2: Skipping crop (no crop settings)');
    }

    // ========== STEP 3: SORT BY SKU ==========
    if (settings.sortSku) {
      console.log('🔍 Step 3: Extracting SKUs for sorting...');
      const pageData = [];
      const pageCount = pdfDoc.getPageCount();
      const currentPdfBytes = await pdfDoc.save();
      
      for (let i = 0; i < pageCount; i++) {
        const sku = await this.extractSKUFromPage(currentPdfBytes, i + 1);
        pageData.push({
          index: i,
          sku: sku || `zzz_no_sku_${String(i).padStart(4, '0')}` // Put pages without SKU at end
        });
      }

      // Sort pages by SKU
      console.log('📊 Sorting pages by SKU...');
      pageData.sort((a, b) => {
        const skuA = a.sku.toUpperCase();
        const skuB = b.sku.toUpperCase();
        return skuA.localeCompare(skuB);
      });

      // Create new PDF with sorted pages
      console.log('📄 Creating sorted PDF...');
      const sortedPdf = await PDFDocument.create();
      for (const data of pageData) {
        const [copiedPage] = await sortedPdf.copyPages(pdfDoc, [data.index]);
        sortedPdf.addPage(copiedPage);
        console.log(`  ✓ Page ${data.index + 1}: ${data.sku}`);
      }
      
      pdfDoc = sortedPdf;
      console.log('✅ Pages sorted by SKU');
    } else {
      console.log('⏭️ Step 3: Skipping SKU sorting (disabled)');
    }

    // ========== STEP 4: ADD DATE/TIME ==========
    if (settings.addDateTime) {
      console.log('📅 Step 4: Adding date/time...');
      await this.addDateTime(pdfDoc);
    } else {
      console.log('⏭️ Step 4: Skipping date/time');
    }

    // ========== STEP 5: ADD CUSTOM TEXT ==========
    if (settings.addText && settings.customText) {
      console.log('📝 Step 5: Adding custom text...');
      await this.addCustomText(pdfDoc, settings.customText);
    } else {
      console.log('⏭️ Step 5: Skipping custom text');
    }

    const pdfBytes = await pdfDoc.save();
    console.log('✅ Processing complete -', pdfBytes.length, 'bytes');
    console.log('📦 Final page count:', pdfDoc.getPageCount());
    return pdfBytes;

  } catch (error) {
    console.error('❌ Processing error:', error.message);
    console.error('Stack:', error.stack);
    throw new Error('PDF processing failed: ' + error.message);
  }
}
  // Flipkart-specific cropping (creates new document with cropped pages)
  static async cropFlipkart(pdfDoc, cropBox) {
    const newPdf = await PDFDocument.create();
    const pageCount = pdfDoc.getPageCount();

    console.log(`✂️ Starting Flipkart crop for ${pageCount} pages...`);

    for (let i = 0; i < pageCount; i++) {
      try {
        // Copy page from original document
        const [copiedPage] = await newPdf.copyPages(pdfDoc, [i]);
        
        const { width: pageWidth, height: pageHeight } = copiedPage.getSize();
        console.log(`  Page ${i + 1}: ${pageWidth}×${pageHeight}pt`);
        
        // Apply crop box using the coordinates from working demo
        // setCropBox(x, y, width, height)
        copiedPage.setCropBox(165, 460, 265, 360);
        
        // Add the cropped page
        newPdf.addPage(copiedPage);
        
        console.log(`  ✅ Cropped to 265×360pt at (165,460)`);
      } catch (error) {
        console.error(`  ❌ Error cropping page ${i + 1}:`, error.message);
        throw error;
      }
    }

    console.log(`✅ ${newPdf.getPageCount()} pages cropped successfully`);
    return newPdf;
  }

  // Margin-based cropping for other platforms
  static async applyMarginCrop(pdfDoc, marginPx) {
    const pages = pdfDoc.getPages();
    
    for (const page of pages) {
      const { width, height } = page.getSize();
      const newWidth = width - (2 * marginPx);
      const newHeight = height - (2 * marginPx);
      
      if (newWidth > 0 && newHeight > 0) {
        page.setCropBox(marginPx, marginPx, newWidth, newHeight);
      }
    }
  }

  // Add date/time stamp
  static async addDateTime(pdfDoc) {
    const pages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const now = new Date();
    const dateTimeText = now.toLocaleString('en-IN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });

    for (const page of pages) {
      const { width, height } = page.getSize();
      const textWidth = font.widthOfTextAtSize(dateTimeText, 8);
      
      page.drawText(dateTimeText, {
        x: width - textWidth - 10,
        y: 10,
        size: 8,
        font: font,
        color: rgb(0.3, 0.3, 0.3)
      });
    }
  }

  // Add custom text
  static async addCustomText(pdfDoc, text) {
    if (!text || text.trim() === '') return;
    
    const pages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    for (const page of pages) {
      const { width, height } = page.getSize();
      const textWidth = font.widthOfTextAtSize(text, 12);
      
      page.drawText(text, {
        x: (width - textWidth) / 2,
        y: height - 25,
        size: 12,
        font: font,
        color: rgb(0, 0, 0)
      });
    }
  }
}

module.exports = PDFProcessor;