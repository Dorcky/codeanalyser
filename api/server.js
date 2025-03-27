require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { createHash } = require('crypto');
const { put, del, list } = require('@vercel/blob');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const officegen = require('officegen');
const officeparser = require('officeparser');
const path = require('path');
const cors = require('cors');

const app = express();
const upload = multer({ memory: true }); 

// Configuration CORS
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(cors({
    origin: ['https://your-vercel-domain.vercel.app', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Vérification de la clé API Gemini
if (!process.env.GEMINI_API_KEY) {
  console.error("❌ ERREUR: La clé API GEMINI_API_KEY n'est pas définie dans le fichier .env");
  process.exit(1);
}

console.log("✅ Clé API Gemini trouvée");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = "gemini-1.5-pro";

// Générer un nom de fichier unique
function generateUniqueFileName(originalname) {
  const timestamp = Date.now();
  const hash = createHash('md5')
    .update(`${originalname}-${timestamp}`)
    .digest('hex');
  return `${hash}-${originalname}`;
}

// Détecter le type de fichier
function getFileType(mimetype, filename) {
  if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      filename.endsWith('.docx')) {
    return 'word';
  } else if (mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
             filename.endsWith('.xlsx')) {
    return 'excel';
  } else if (mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
             filename.endsWith('.pptx')) {
    return 'powerpoint';
  } else if (mimetype.startsWith('text/') || mimetype === 'application/json' ||
             ['.js', '.py', '.html', '.css', '.json', '.txt'].some(ext => filename.endsWith(ext))) {
    return 'text';
  } else {
    return 'unsupported';
  }
}

// Extraire le contenu d'un fichier Word
async function extractWordContent(fileBuffer) {
  try {
    const result = await mammoth.extractRawText({ 
      buffer: Buffer.from(fileBuffer) 
    });
    return result.value;
  } catch (error) {
    console.error('Erreur lors de l\'extraction du contenu Word:', error);
    throw error;
  }
}

// Extraire le contenu d'un fichier Excel
async function extractExcelContent(fileBuffer) {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer);
   
    let content = '';
    workbook.eachSheet((worksheet, sheetId) => {
      content += `Feuille: ${worksheet.name}\n`;
     
      worksheet.eachRow((row, rowNumber) => {
        const rowValues = row.values.slice(1).join('\t');
        content += `${rowNumber}: ${rowValues}\n`;
      });
      content += '\n';
    });
   
    return content;
  } catch (error) {
    console.error('Erreur lors de l\'extraction du contenu Excel:', error);
    throw error;
  }
}

// Extraire le contenu d'un fichier PowerPoint
async function extractPowerPointContent(fileBuffer) {
  try {
    const content = await officeparser.parsePptx(Buffer.from(fileBuffer));
    return content;
  } catch (error) {
    console.error('Erreur lors de l\'extraction du contenu PowerPoint:', error);
    throw error;
  }
}

// Créer un nouveau fichier Word modifié
async function createModifiedWordDocument(content) {
  const docx = officegen('docx');
 
  const paragraphs = content.split('\n');
  paragraphs.forEach(para => {
    if (para.trim()) {
      const p = docx.createP();
      p.addText(para);
    }
  });
 
  return new Promise((resolve, reject) => {
    const out = Buffer.from([]);
    docx.on('error', reject);
   
    docx.generate(out);
    resolve(out);
  });
}

// Créer un nouveau fichier Excel modifié
async function createModifiedExcelWorkbook(content) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Feuille1');
 
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    if (line.trim()) {
      const cells = line.split('\t');
      const row = worksheet.getRow(index + 1);
      cells.forEach((cell, cellIndex) => {
        row.getCell(cellIndex + 1).value = cell;
      });
      row.commit();
    }
  });
 
  return workbook.xlsx.writeBuffer();
}

// Créer un nouveau fichier PowerPoint modifié
async function createModifiedPowerPoint(content) {
  const pptx = officegen('pptx');
 
  const slides = content.split('\n\n');
  slides.forEach(slideContent => {
    if (slideContent.trim()) {
      const slide = pptx.makeNewSlide();
      slide.addText(slideContent, { x: 50, y: 50, w: '80%', h: '80%' });
    }
  });
 
  return new Promise((resolve, reject) => {
    const out = Buffer.from([]);
    pptx.on('error', reject);
   
    pptx.generate(out);
    resolve(out);
  });
}

// 📤 Route d'upload de fichier
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucun fichier envoyé." });

  try {
    const uniqueFileName = generateUniqueFileName(req.file.originalname);
    
    // Upload to Vercel Blob Storage
    const blob = await put(uniqueFileName, req.file.buffer, {
      access: 'temporary',
      contentType: req.file.mimetype
    });

    res.json({
      message: "Fichier téléversé avec succès",
      filename: uniqueFileName,
      fileType: getFileType(req.file.mimetype, req.file.originalname),
      url: blob.url
    });
  } catch (error) {
    console.error('Erreur d\'upload:', error);
    res.status(500).json({ error: "Échec du téléversement du fichier", details: error.message });
  }
});

// 🛠 Route d'édition de fichier avec Gemini
app.post('/api/edit-file', async (req, res) => {
  const { filename, instructions } = req.body;

  if (!filename) {
    return res.status(400).json({ error: "Nom de fichier requis." });
  }

  try {
    // Lister les blobs pour trouver le fichier
    const { blobs } = await list({ 
      prefix: filename 
    });

    if (blobs.length === 0) {
      return res.status(404).json({ error: "Fichier non trouvé." });
    }

    const blob = blobs[0];
    const fileType = getFileType(blob.contentType, filename);

    // Récupérer le contenu original
    const response = await fetch(blob.url);
    const fileBuffer = await response.arrayBuffer();

    let originalContent = '';
    switch (fileType) {
      case 'word':
        originalContent = await extractWordContent(fileBuffer);
        break;
      case 'excel':
        originalContent = await extractExcelContent(fileBuffer);
        break;
      case 'powerpoint':
        originalContent = await extractPowerPointContent(fileBuffer);
        break;
      case 'text':
        originalContent = new TextDecoder().decode(fileBuffer);
        break;
      default:
        throw new Error('Type de fichier non supporté');
    }

    // Utiliser Gemini pour éditer le contenu
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });
    const prompt = `Voici un ${fileType}.  
    Applique strictement les modifications suivantes sans ajouter d'explication, de commentaires génériques, ni aucun élément superflu.  
    ⚠️ **Important** :
    - **Ne** renvoie **aucune** balise de code comme \`\`\` ou \`\`\`html. **Ne fais pas de mise en forme supplémentaire**.  
    - **Ne** raccourcissez **pas** le document initial.  
    - **Ne** supprimez **pas** de contenu existant.  
    - **Ne** faites **pas** de mise en forme supplémentaire.  
    - **Ne** rajoutez **pas** de commentaires.  

    Modifie uniquement ce qui est demandé :  
    "${instructions}"  

    Contenu original :  
    ${originalContent}`;

    const result = await model.generateContent(prompt);
    const editedContent = result.response.text();

    // Créer un nouveau blob avec le contenu édité
    let editedBuffer;
    let contentType = blob.contentType;
    switch (fileType) {
      case 'word':
        editedBuffer = await createModifiedWordDocument(editedContent);
        break;
      case 'excel':
        editedBuffer = await createModifiedExcelWorkbook(editedContent);
        break;
      case 'powerpoint':
        editedBuffer = await createModifiedPowerPoint(editedContent);
        break;
      case 'text':
        editedBuffer = Buffer.from(editedContent);
        break;
    }

    const editedFileName = `edited-${filename}`;
    const editedBlob = await put(editedFileName, editedBuffer, {
      access: 'temporary',
      contentType: contentType
    });

    res.json({
      message: "Fichier modifié avec succès",
      editedFilename: editedFileName,
      type: fileType,
      url: editedBlob.url
    });
  } catch (error) {
    console.error('Erreur d\'édition du fichier:', error);
    res.status(500).json({ error: "Échec de la modification du fichier", details: error.message });
  }
});

// 📂 Route pour lister les fichiers
app.get('/api/files', async (req, res) => {
  try {
    const { blobs } = await list();
    const files = blobs.map(blob => ({
      filename: blob.pathname,
      originalname: blob.pathname,
      mimetype: blob.contentType,
      size: blob.size,
      type: getFileType(blob.contentType, blob.pathname)
    }));
    res.json(files);
  } catch (error) {
    console.error('Erreur de listage des fichiers:', error);
    res.status(500).json({ error: "Impossible de lister les fichiers" });
  }
});

// 📄 Route pour lire le contenu d'un fichier
app.get('/api/file-content/:filename', async (req, res) => {
  const { filename } = req.params;

  try {
    const { blobs } = await list({ prefix: filename });
    if (blobs.length === 0) {
      return res.status(404).json({ error: "Fichier non trouvé" });
    }

    const blob = blobs[0];
    const fileType = getFileType(blob.contentType, filename);
    
    const response = await fetch(blob.url);
    const fileBuffer = await response.arrayBuffer();

    let content = '';
    switch (fileType) {
      case 'word':
        content = await extractWordContent(fileBuffer);
        break;
      case 'excel':
        content = await extractExcelContent(fileBuffer);
        break;
      case 'powerpoint':
        content = await extractPowerPointContent(fileBuffer);
        break;
      case 'text':
        content = new TextDecoder().decode(fileBuffer);
        break;
      default:
        return res.json({ error: "Aperçu non disponible pour ce type de fichier." });
    }
   
    res.json({ content });
  } catch (error) {
    console.error('Erreur de lecture du fichier:', error);
    res.status(500).json({ error: "Impossible de lire le contenu du fichier", details: error.message });
  }
});

// 📥 Route pour télécharger un fichier
app.get('/api/download/:filename', async (req, res) => {
  const { filename } = req.params;

  try {
    const { blobs } = await list({ prefix: filename });
    if (blobs.length === 0) {
      return res.status(404).json({ error: "Fichier non trouvé" });
    }

    const blob = blobs[0];
    res.redirect(blob.url);
  } catch (error) {
    console.error('Erreur de téléchargement:', error);
    res.status(500).json({ error: "Échec du téléchargement", details: error.message });
  }
});

// 🗑 Route pour supprimer un fichier
app.delete('/api/delete/:filename', async (req, res) => {
  const { filename } = req.params;

  try {
    await del(filename);
    res.json({ message: "Fichier supprimé avec succès" });
  } catch (error) {
    console.error('Erreur de suppression du fichier:', error);
    res.status(500).json({ error: "Échec de la suppression du fichier", details: error.message });
  }
});

// Route par défaut pour Vercel
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Exportation pour Vercel
module.exports = app;