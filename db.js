require('dotenv').config();
const sql = require('mssql');

const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    server: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT || '1433', 10),
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    },
    options: {
        encrypt: false, // para desarrollo local usualmente es false, o true si estás en Azure
        trustServerCertificate: true // útil para SQL Express local
    }
};

let poolPromise = null;

async function connectToDatabase() {
    if (poolPromise) {
        return poolPromise;
    }
    
    try {
        console.log('Conectando a MS SQL Express...');
        poolPromise = await sql.connect(dbConfig);
        console.log('✅ Conexión a la base de datos establecida.');
        return poolPromise;
    } catch (err) {
        console.error('❌ Error al conectar a la base de datos:', err);
        poolPromise = null;
        throw err;
    }
}

async function query(queryString) {
    try {
        const pool = await connectToDatabase();
        const result = await pool.request().query(queryString);
        return result.recordset;
    } catch (err) {
        console.error('Error ejecutando query:', err);
        throw err;
    }
}

async function searchProducts(searchTerm) {
    try {
        const pool = await connectToDatabase();
        // Buscar productos que coincidan con la descripción (limitado a 15)
        const result = await pool.request()
            .input('term', sql.VarChar, `%${searchTerm}%`)
            .query(`
                SELECT TOP 15 [ARTICULO], [DESCRIP], [PRECIO1] 
                FROM prods 
                WHERE [DESCRIP] LIKE @term
            `);
        return result.recordset;
    } catch (err) {
        console.error('Error en searchProducts:', err);
        throw err;
    }
}

module.exports = {
    sql,
    connectToDatabase,
    query,
    searchProducts
};
