require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const officegen = require('officegen');
const officeparser = require('officeparser');

const app = express();
const port = 3020;
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

if (!process.env.GEMINI_API_KEY) {
  console.error("❌ ERREUR: La clé API GEMINI_API_KEY n'est pas définie dans le fichier .env");
  process.exit(1);
}

console.log("✅ Clé API Gemini trouvée");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = "gemini-1.5-flash";

let uploadedFiles = {}; // Stockage des fichiers temporairement

// Fonction utilitaire pour détecter le type de fichier
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

// 📤 API d'upload d'un fichier
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucun fichier envoyé." });

  console.log(`📤 Fichier reçu: ${req.file.originalname}`);
  const fileType = getFileType(req.file.mimetype, req.file.originalname);
  
  uploadedFiles[req.file.filename] = {
    path: req.file.path,
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    type: fileType
  };

  res.json({ 
    message: "Fichier téléversé avec succès", 
    filename: req.file.filename,
    fileType: fileType 
  });
});

// Extraire le contenu d'un fichier Word
async function extractWordContent(filePath) {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  } catch (error) {
    console.error('Erreur lors de l\'extraction du contenu Word:', error);
    throw error;
  }
}

// Extraire le contenu d'un fichier Excel
async function extractExcelContent(filePath) {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    
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
async function extractPowerPointContent(filePath) {
  try {
    const content = await officeparser.parsePptx(filePath);
    return content;
  } catch (error) {
    console.error('Erreur lors de l\'extraction du contenu PowerPoint:', error);
    throw error;
  }
}

// Créer un nouveau fichier Word modifié
async function createModifiedWordDocument(content, outputPath) {
  const docx = officegen('docx');
  
  // Ajouter du contenu
  const paragraphs = content.split('\n');
  paragraphs.forEach(para => {
    if (para.trim()) {
      const p = docx.createP();
      p.addText(para);
    }
  });
  
  // Générer le fichier
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outputPath);
    out.on('error', reject);
    
    docx.on('error', reject);
    
    out.on('close', () => {
      resolve(outputPath);
    });
    
    docx.generate(out);
  });
}

// Créer un nouveau fichier Excel modifié
async function createModifiedExcelWorkbook(content, outputPath) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Feuille1');
  
  // Ajouter le contenu
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
  
  // Sauvegarder le fichier
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

// Créer un nouveau fichier PowerPoint modifié
async function createModifiedPowerPoint(content, outputPath) {
  const pptx = officegen('pptx');
  
  // Diviser le contenu en slides
  const slides = content.split('\n\n');
  slides.forEach(slideContent => {
    if (slideContent.trim()) {
      const slide = pptx.makeNewSlide();
      slide.addText(slideContent, { x: 50, y: 50, w: '80%', h: '80%' });
    }
  });
  
  // Générer le fichier
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outputPath);
    out.on('error', reject);
    
    pptx.on('error', reject);
    
    out.on('close', () => {
      resolve(outputPath);
    });
    
    pptx.generate(out);
  });
}

// 🛠 API d'édition du fichier avec Gemini
// 🛠 API d'édition du fichier avec Gemini
app.post('/edit-file', async (req, res) => {
  const { filename, instructions } = req.body;

  if (!filename || !uploadedFiles[filename]) {
    return res.status(400).json({ error: "Fichier introuvable." });
  }

  if (!instructions) {
    return res.status(400).json({ error: "Instructions manquantes." });
  }

  const filePath = uploadedFiles[filename].path;
  const fileType = uploadedFiles[filename].type;
  console.log(`✍️ Édition du fichier: ${filename} (${fileType}) avec instructions: "${instructions}"`);

  try {
    let originalContent = '';
    let fileDescription = '';
    
    // Extraire le contenu en fonction du type de fichier
    switch (fileType) {
      case 'word':
        originalContent = await extractWordContent(filePath);
        fileDescription = 'document Word (DOCX)';
        break;
      case 'excel':
        originalContent = await extractExcelContent(filePath);
        fileDescription = 'feuille de calcul Excel (XLSX)';
        break;
      case 'powerpoint':
        originalContent = await extractPowerPointContent(filePath);
        fileDescription = 'présentation PowerPoint (PPTX)';
        break;
      case 'text':
        originalContent = fs.readFileSync(filePath, 'utf-8');
        const extension = path.extname(uploadedFiles[filename].originalname);
        fileDescription = `fichier de code (${extension})`;
        break;
      default:
        return res.status(400).json({ error: "Type de fichier non pris en charge pour l'édition." });
    }

    const model = genAI.getGenerativeModel({ model: MODEL_NAME });

    const prompt = `Voici un ${fileDescription}.  
    Applique strictement les modifications suivantes sans ajouter d'explication, de commentaires génériques, ni aucun élément superflu.  
    ⚠️ **Important** : 
    - **Ne** renvoie **aucune** balise de code comme \`\`\` ou \`\`\`html. **Ne fais pas de mise en forme supplémentaire**.  
    - **Ne** raccourcissez **pas** le document initial.  
    - **Ne** supprimez **pas** de contenu existant.  
    - **Ne** faites **pas** de mise en forme supplémentaire.  
    - **Ne** rajoutez **pas** de commentaires comme "Previous JavaScript remains the same".  

    Modifie uniquement ce qui est demandé :  
    "${instructions}"  

    Contenu original :  
    ${originalContent}`;

    console.log("🚀 Envoi de la requête à Gemini...");
    const result = await model.generateContent(prompt);
    console.log("✅ Réponse reçue de Gemini");

    let editedContent = result.response.text();

    // Nettoyer le contenu généré
    editedContent = editedContent.split('\n')
      .filter(line => !line.includes('Previous JavaScript remains the same'))
      .join('\n');

    // Sauvegarde du fichier modifié
    const editedFilename = `edited_${filename}`;
    const editedFilePath = `uploads/${editedFilename}`;
    
    // Créer le fichier modifié selon son type
    switch (fileType) {
      case 'word':
        await createModifiedWordDocument(editedContent, editedFilePath);
        break;
      case 'excel':
        await createModifiedExcelWorkbook(editedContent, editedFilePath);
        break;
      case 'powerpoint':
        await createModifiedPowerPoint(editedContent, editedFilePath);
        break;
      case 'text':
        fs.writeFileSync(editedFilePath, editedContent, 'utf-8');
        break;
    }
    
    uploadedFiles[editedFilename] = {
      path: editedFilePath,
      originalname: `edited_${uploadedFiles[filename].originalname}`,
      mimetype: uploadedFiles[filename].mimetype,
      size: fs.statSync(editedFilePath).size,
      type: fileType
    };

    console.log(`📂 Fichier édité sauvegardé: ${editedFilename}`);

    res.json({ 
      message: "Fichier modifié avec succès", 
      editedFilename: editedFilename,
      type: fileType
    });

  } catch (error) {
    console.error('❌ Erreur d\'édition:', error);
    res.status(500).json({ error: "Erreur lors de l'édition du fichier", details: error.message });
  }
});

// 📂 API pour lister les fichiers
app.get('/files', (req, res) => {
  const files = Object.keys(uploadedFiles).map(filename => ({
    filename,
    originalname: uploadedFiles[filename].originalname,
    mimetype: uploadedFiles[filename].mimetype,
    size: uploadedFiles[filename].size,
    type: uploadedFiles[filename].type
  }));
  res.json(files);
});

// 📄 API pour lire le contenu d'un fichier
app.get('/file-content/:filename', async (req, res) => {
  const { filename } = req.params;

  if (!uploadedFiles[filename]) {
    return res.status(404).json({ error: "Fichier non trouvé." });
  }

  const filePath = uploadedFiles[filename].path;
  const fileType = uploadedFiles[filename].type;

  try {
    let content = '';
    
    switch (fileType) {
      case 'word':
        content = await extractWordContent(filePath);
        break;
      case 'excel':
        content = await extractExcelContent(filePath);
        break;
      case 'powerpoint':
        content = await extractPowerPointContent(filePath);
        break;
      case 'text':
        content = fs.readFileSync(filePath, 'utf-8');
        break;
      default:
        return res.json({ error: "Aperçu non disponible pour ce type de fichier." });
    }
    
    res.json({ content });
  } catch (error) {
    console.error('❌ Erreur lors de la lecture du fichier:', error);
    res.status(500).json({ error: "Erreur lors de la lecture du fichier", details: error.message });
  }
});

// 📥 API pour télécharger un fichier
app.get('/download/:filename', (req, res) => {
  const { filename } = req.params;

  if (!uploadedFiles[filename]) {
    return res.status(404).json({ error: "Fichier non trouvé." });
  }

  const filePath = uploadedFiles[filename].path;
  res.download(filePath, uploadedFiles[filename].originalname);
});

// 🗑 API pour supprimer un fichier
app.delete('/delete/:filename', (req, res) => {
  const { filename } = req.params;

  if (!uploadedFiles[filename]) {
    return res.status(404).json({ error: "Fichier non trouvé." });
  }

  fs.unlink(uploadedFiles[filename].path, (err) => {
    if (err) {
      console.error('❌ Erreur lors de la suppression du fichier:', err);
      return res.status(500).json({ error: "Erreur lors de la suppression du fichier", details: err.message });
    }

    delete uploadedFiles[filename];
    console.log(`🗑 Fichier supprimé: ${filename}`);
    res.json({ message: "Fichier supprimé avec succès" });
  });
});

// Lancer le serveur
app.listen(port, () => {
  console.log(`✅ Serveur en ligne sur http://localhost:${port}`);
  console.log(`🤖 Modèle configuré: ${MODEL_NAME}`);
});