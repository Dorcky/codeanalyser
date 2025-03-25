const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const { GridFsStorage } = require('multer-gridfs-storage');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const officegen = require('officegen');
const officeparser = require('officeparser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3020;

// Configuration CORS
app.use(cors({
    origin: true,  // More permissive for development
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connexion à MongoDB
// Add this before app.listen()
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch((err) => console.error('❌ MongoDB connection error:', err));


// Modèle de fichier
const FileSchema = new mongoose.Schema({
  filename: String,
  originalname: String,
  mimetype: String,
  size: Number,
  uploadDate: { type: Date, default: Date.now },
  fileType: String,
  content: Buffer
});

const File = mongoose.model('File', FileSchema);

// Configuration du stockage GridFS
const storage = new GridFsStorage({
    url: process.env.MONGODB_URI,
    file: (req, file) => {
        return {
            filename: `${Date.now()}-${file.originalname}`,
            bucketName: 'uploads',
            metadata: {
                originalname: file.originalname,
                mimetype: file.mimetype
            }
        };
    }
});

const upload = multer({ storage });

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

// Configuration de Gemini AI
if (!process.env.GEMINI_API_KEY) {
  console.error("❌ ERREUR: La clé API GEMINI_API_KEY n'est pas définie");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = "gemini-1.5-pro";

// Fonction pour extraire le contenu des différents types de fichiers
async function extractFileContent(file, fileType) {
  const buffer = file.buffer;
  const tempFilePath = path.join(process.env.TEMP_DIR || '/tmp', file.filename);
  
  // Écrire le buffer dans un fichier temporaire
  fs.writeFileSync(tempFilePath, buffer);

  try {
    switch(fileType) {
      case 'word':
        return await extractWordContent(tempFilePath);
      case 'excel':
        return await extractExcelContent(tempFilePath);
      case 'powerpoint':
        return await extractPowerPointContent(tempFilePath);
      case 'text':
        return buffer.toString('utf-8');
      default:
        throw new Error('Type de fichier non supporté');
    }
  } finally {
    // Nettoyer le fichier temporaire
    fs.unlinkSync(tempFilePath);
  }
}

// Fonctions d'extraction (similaires à votre implémentation précédente)
async function extractWordContent(filePath) { /* ... */ }
async function extractExcelContent(filePath) { /* ... */ }
async function extractPowerPointContent(filePath) { /* ... */ }

// Route d'upload de fichier
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Aucun fichier envoyé." });
    }

    // Sauvegarder les métadonnées du fichier
    const newFile = new File({
      filename: req.file.filename,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      fileType: req.file.metadata.fileType
    });
    await newFile.save();

    res.json({ 
      message: "Fichier téléversé avec succès", 
      filename: req.file.filename,
      fileType: req.file.metadata.fileType 
    });
  } catch (error) {
    console.error('Erreur lors de l\'upload:', error);
    res.status(500).json({ error: "Erreur lors du téléversement" });
  }
});

// Route d'édition de fichier
app.post('/edit-file', async (req, res) => {
  const { filename, instructions } = req.body;

  try {
    // Récupérer le fichier depuis MongoDB
    const file = await File.findOne({ filename });
    if (!file) {
      return res.status(404).json({ error: "Fichier non trouvé." });
    }

    // Récupérer le fichier réel depuis GridFS
    const gfs = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: 'uploads'
    });

    const downloadStream = gfs.openDownloadStreamByName(filename);
    const chunks = [];

    downloadStream.on('data', (chunk) => {
      chunks.push(chunk);
    });

    downloadStream.on('end', async () => {
      const buffer = Buffer.concat(chunks);
      
      // Écrire le buffer dans un fichier temporaire
      const tempFilePath = path.join(process.env.TEMP_DIR || '/tmp', filename);
      fs.writeFileSync(tempFilePath, buffer);

      try {
        // Extraire le contenu
        const originalContent = await extractFileContent({ 
          buffer, 
          filename, 
          metadata: { fileType: file.fileType } 
        }, file.fileType);

        // Utiliser Gemini pour modifier le contenu
        const model = genAI.getGenerativeModel({ model: MODEL_NAME });
        const prompt = `Voici un ${file.fileType}. Applique strictement les modifications suivantes : "${instructions}"`;
        
        const result = await model.generateContent(prompt + "\n\n" + originalContent);
        const editedContent = result.response.text();

        // Sauvegarder le fichier modifié
        const editedFilename = `edited_${filename}`;
        const editedFile = new File({
          filename: editedFilename,
          originalname: `edited_${file.originalname}`,
          mimetype: file.mimetype,
          fileType: file.fileType,
          content: Buffer.from(editedContent)
        });
        await editedFile.save();

        // Supprimer le fichier temporaire
        fs.unlinkSync(tempFilePath);

        res.json({ 
          message: "Fichier modifié avec succès", 
          editedFilename: editedFilename,
          type: file.fileType 
        });
      } catch (error) {
        console.error('Erreur d\'édition:', error);
        res.status(500).json({ error: "Erreur lors de l'édition du fichier" });
      }
    });

    downloadStream.on('error', (error) => {
      console.error('Erreur de lecture du fichier:', error);
      res.status(500).json({ error: "Erreur de lecture du fichier" });
    });
  } catch (error) {
    console.error('Erreur lors de l\'édition:', error);
    res.status(500).json({ error: "Erreur lors de l'édition du fichier" });
  }
});

// Route pour lister les fichiers
app.get('/files', async (req, res) => {
  try {
    const files = await File.find({}, 'filename originalname mimetype size fileType');
    res.json(files);
  } catch (error) {
    console.error('Erreur lors de la récupération des fichiers:', error);
    res.status(500).json({ error: "Erreur lors de la récupération des fichiers" });
  }
});

// Route pour récupérer le contenu d'un fichier
app.get('/file-content/:filename', async (req, res) => {
  try {
    const file = await File.findOne({ filename: req.params.filename });
    if (!file) {
      return res.status(404).json({ error: "Fichier non trouvé." });
    }

    const gfs = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: 'uploads'
    });

    const downloadStream = gfs.openDownloadStreamByName(req.params.filename);
    const chunks = [];

    downloadStream.on('data', (chunk) => {
      chunks.push(chunk);
    });

    downloadStream.on('end', async () => {
      const buffer = Buffer.concat(chunks);
      
      try {
        const content = await extractFileContent({ 
          buffer, 
          filename: file.filename, 
          metadata: { fileType: file.fileType } 
        }, file.fileType);

        res.json({ content });
      } catch (error) {
        console.error('Erreur lors de l\'extraction du contenu:', error);
        res.status(500).json({ error: "Erreur lors de l'extraction du contenu" });
      }
    });

    downloadStream.on('error', (error) => {
      console.error('Erreur de lecture du fichier:', error);
      res.status(500).json({ error: "Erreur de lecture du fichier" });
    });
  } catch (error) {
    console.error('Erreur lors de la récupération du contenu:', error);
    res.status(500).json({ error: "Erreur lors de la récupération du contenu" });
  }
});

// Route pour télécharger un fichier
app.get('/download/:filename', async (req, res) => {
  try {
    const file = await File.findOne({ filename: req.params.filename });
    if (!file) {
      return res.status(404).json({ error: "Fichier non trouvé." });
    }

    const gfs = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: 'uploads'
    });

    const downloadStream = gfs.openDownloadStreamByName(req.params.filename);
    
    res.set('Content-Type', file.mimetype);
    res.set('Content-Disposition', `attachment; filename="${file.originalname}"`);
    
    downloadStream.pipe(res);
  } catch (error) {
    console.error('Erreur lors du téléchargement:', error);
    res.status(500).json({ error: "Erreur lors du téléchargement du fichier" });
  }
});

// Route pour supprimer un fichier
app.delete('/delete/:filename', async (req, res) => {
  try {
    const gfs = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: 'uploads'
    });

    // Trouver le fichier dans la base de données
    const file = await File.findOne({ filename: req.params.filename });
    if (!file) {
      return res.status(404).json({ error: "Fichier non trouvé." });
    }

    // Supprimer le fichier de GridFS
    const fileToDelete = await gfs.find({ filename: req.params.filename }).toArray();
    if (fileToDelete.length > 0) {
      await gfs.delete(fileToDelete[0]._id);
    }

    // Supprimer l'entrée de la collection File
    await File.deleteOne({ filename: req.params.filename });

    res.json({ message: "Fichier supprimé avec succès" });
  } catch (error) {
    console.error('Erreur lors de la suppression:', error);
    res.status(500).json({ error: "Erreur lors de la suppression du fichier" });
  }
});


// Démarrer le serveur
app.listen(port, () => {
  console.log(`✅ Serveur en ligne sur http://localhost:${port}`);
  console.log(`🤖 Modèle configuré: ${MODEL_NAME}`);
});

module.exports = app;