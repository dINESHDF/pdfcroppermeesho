const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const PDFProcessor = require('./api/pdfProcessor');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory "database"
const users = [];

// Ensure directories exist
const dirs = ['uploads', 'cropped', 'public', 'views', 'api'];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use('/cropped', express.static('cropped'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ 
  secret: 'pdfsecret', 
  resave: false, 
  saveUninitialized: false,
  cookie: { secure: false }
}));

// Default admin user
(async () => {
  const hashedPassword = await bcrypt.hash('admin@123', 10);
  users.push({ id: 1, username: 'admin', password: hashedPassword });
  console.log('✅ Default admin user created');
})();

// Multer setup for multiple file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({ 
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Middleware to protect routes
function isAuthenticated(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}

// Routes
app.get('/', (req, res) => {
  try {
    res.render('index', { user: req.session.userId || null });
  } catch (error) {
    console.error('Error rendering index:', error);
    res.send('Error loading page: ' + error.message);
  }
});

app.get('/signup', (req, res) => {
  try {
    res.render('signup', { user: req.session.userId || null, error: null });
  } catch (error) {
    console.error('Error rendering signup:', error);
    res.send('Error loading signup page: ' + error.message);
  }
});

app.post('/signup', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const existingUser = users.find(u => u.username === username);
    if (existingUser) {
      return res.render('signup', { 
        user: null, 
        error: 'Username already exists' 
      });
    }
    
    const hashed = await bcrypt.hash(password, 10);
    users.push({ id: Date.now(), username, password: hashed });
    console.log(`✅ New user registered: ${username}`);
    res.redirect('/login');
  } catch (error) {
    console.error('Signup error:', error);
    res.render('signup', { 
      user: null, 
      error: 'An error occurred during signup' 
    });
  }
});

app.get('/login', (req, res) => {
  try {
    res.render('login', { user: req.session.userId || null, error: null });
  } catch (error) {
    console.error('Error rendering login:', error);
    res.send('Error loading login page: ' + error.message);
  }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    
    if (user && await bcrypt.compare(password, user.password)) {
      req.session.userId = user.id;
      req.session.username = user.username;
      console.log(`✅ User logged in: ${username}`);
      res.redirect('/dashboard');
    } else {
      res.render('login', { 
        user: null, 
        error: 'Invalid username or password' 
      });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.render('login', { 
      user: null, 
      error: 'An error occurred during login' 
    });
  }
});

app.get('/logout', (req, res) => {
  const username = req.session.username;
  req.session.destroy();
  console.log(`✅ User logged out: ${username}`);
  res.redirect('/');
});

app.get('/dashboard', isAuthenticated, (req, res) => {
  try {
    res.render('dashboard', { 
      user: req.session.userId,
      username: req.session.username 
    });
  } catch (error) {
    console.error('Error rendering dashboard:', error);
    res.send('Error loading dashboard: ' + error.message);
  }
});

// PDF Upload and Processing Route
app.post('/upload', isAuthenticated, upload.array('pdf', 10), async (req, res) => {
  const uploadedFiles = req.files;
  
  try {
    if (!uploadedFiles || uploadedFiles.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
// Extract settings from request
const settings = {
  mergePdf: req.body.mergePdf === 'true',
  addDateTime: req.body.addDateTime === 'true',
  sortSku: req.body.sortSku === 'true',  // ADD THIS LINE
  keepInvoice: req.body.keepInvoice === 'true',
  addText: req.body.addText === 'true',
  customText: req.body.customText || '',
  multiOrders: req.body.multiOrders === 'true',
  margin: req.body.margin || '50',
  platform: req.body.platform || 'custom'
};    console.log(`📄 Processing ${uploadedFiles.length} PDF(s) with settings:`, settings);

    // Get file paths
    const filePaths = uploadedFiles.map(file => file.path);

    // Apply platform preset
    const preset = PDFProcessor.getPlatformPreset(settings.platform);
    if (!settings.margin || settings.margin === '50') {
      settings.margin = preset.margin.toString();
    }

    // Process PDFs with all selected options
    const processedPdfBytes = await PDFProcessor.processPDF(filePaths, settings);

    // Generate output filename
    const timestamp = Date.now();
    const outputFilename = settings.mergePdf && uploadedFiles.length > 1
      ? `merged-${timestamp}.pdf`
      : `processed-${timestamp}-${uploadedFiles[0].originalname}`;
    
    const outputPath = path.join('cropped', outputFilename);

    // Save processed PDF
    await fs.promises.writeFile(outputPath, processedPdfBytes);

    // Clean up uploaded files
    for (const file of uploadedFiles) {
      try {
        await fs.promises.unlink(file.path);
      } catch (err) {
        console.error('Error deleting file:', err);
      }
    }

    console.log(`✅ PDF processed successfully: ${outputFilename}`);

    // Send success response
    res.json({ 
      success: true, 
      message: 'PDF processed successfully!',
      downloadUrl: `/cropped/${outputFilename}`,
      filename: outputFilename,
      settings: settings
    });
    
  } catch (error) {
    console.error('❌ Upload error:', error);
    
    // Clean up files on error
    if (uploadedFiles) {
      for (const file of uploadedFiles) {
        try {
          if (fs.existsSync(file.path)) {
            await fs.promises.unlink(file.path);
          }
        } catch (err) {
          console.error('Error cleaning up file:', err);
        }
      }
    }
    
    res.status(500).json({ 
      error: 'Failed to process PDF',
      message: error.message 
    });
  }
});

// API Info Route
app.get('/api/info', (req, res) => {
  res.json({
    version: '1.0.0',
    features: {
      mergePDF: { status: 'active', description: 'Merge multiple PDFs into one' },
      addDateTime: { status: 'active', description: 'Add date and time stamp' },
      addCustomText: { status: 'active', description: 'Add custom text to PDF' },
      cropPDF: { status: 'active', description: 'Crop PDF with custom margins' },
      keepInvoice: { status: 'coming_soon', description: 'Preserve invoice pages' },
      multiOrders: { status: 'coming_soon', description: 'Reorder multi-item orders to end' }
    },
    platforms: ['meesho', 'flipkart', 'amazon', 'citymall', 'custom']
  });
});

// Static Pages Routes
app.get('/about', (req, res) => {
  res.render('about', { user: req.session.userId || null });
});

app.get('/pricing', (req, res) => {
  res.render('pricing', { user: req.session.userId || null });
});

app.get('/contact', (req, res) => {
  res.render('contact', { 
    user: req.session.userId || null,
    success: null 
  });
});

app.get('/blog', (req, res) => {
  res.render('blog', { user: req.session.userId || null });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).send('Something went wrong! ' + err.message);
});

// 404 Page (EJS)
app.use((req, res) => {
  res.status(404).render('404', {
    user: req.session?.userId || null
  });
});

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║                                                        ║
║          📄 PDF Crop Pro Server Started! 🚀           ║
║                                                        ║
║  Server: http://localhost:${PORT}                        ║
║  API Info: http://localhost:${PORT}/api/info             ║
║                                                        ║
║  Default Admin Credentials:                           ║
║  Username: admin                                      ║
║  Password: admin@123                                  ║
║                                                        ║
║  Features:                                            ║
║  ✅ Merge PDFs                                        ║
║  ✅ Add Date & Time                                   ║
║  ✅ Add Custom Text                                   ║
║  ✅ Crop with Margins                                 ║
║  🔜 Keep Invoice (Coming Soon)                        ║
║  🔜 Multi Orders at Last (Coming Soon)                ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
  `);
  
  // Check if view files exist
  const viewFiles = ['header.ejs', 'footer.ejs', 'index.ejs', 'login.ejs', 'signup.ejs', 'dashboard.ejs'];
  console.log('\n📂 Checking view files:');
  viewFiles.forEach(file => {
    const filePath = path.join(__dirname, 'views', file);
    if (fs.existsSync(filePath)) {
      console.log(`  ✅ ${file}`);
    } else {
      console.log(`  ❌ ${file} NOT FOUND`);
    }
  });
  
  console.log('\n');
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});
