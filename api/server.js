const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { GridFsStorage } = require('multer-gridfs-storage');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Configuration CORS
app.use(cors({
    origin: ['https://codeanalyser.vercel.app', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connexion à MongoDB
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// Vos routes existantes ici, mais préfixées avec /api
app.get('/api/files', async (req, res) => {
    try {
        const files = await File.find({}, 'filename originalname mimetype size fileType');
        res.json(files);
    } catch (error) {
        console.error('Erreur lors de la récupération des fichiers:', error);
        res.status(500).json({ error: "Erreur lors de la récupération des fichiers" });
    }
});

// Exportation pour Vercel
module.exports = app;