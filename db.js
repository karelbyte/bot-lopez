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

async function createSqlClient(nombre) {
    try {
        const pool = await connectToDatabase();
        const rfc = 'XAXX010101000';
        const cp = '40890';
        
        // Verificamos si el cliente ya existe para evitar duplicados
        const check = await pool.request()
            .input('nombre', sql.VarChar, nombre)
            .query(`SELECT [cliente], [NOMBRE] FROM clients WHERE [NOMBRE] = @nombre`);
            
        if (check.recordset.length > 0) {
            return check.recordset[0].cliente;
        }

        // Obtener el código de cliente más grande y sumarle 1
        const maxCodeResult = await pool.request().query(`
            SELECT MAX(TRY_CAST([cliente] AS INT)) as MaxCodigo FROM clients
        `);
        
        let nextCode = 1;
        if (maxCodeResult.recordset.length > 0 && maxCodeResult.recordset[0].MaxCodigo !== null) {
            nextCode = maxCodeResult.recordset[0].MaxCodigo + 1;
        }

        // Formatear el código a 6 dígitos (modificado por el usuario)
        const clienteCodigo = String(nextCode).padStart(6, '0');

        await pool.request()
            .input('cliente', sql.VarChar, clienteCodigo)
            .input('nombre', sql.VarChar, nombre)
            .input('rfc', sql.VarChar, rfc)
            .input('cp', sql.VarChar, cp)
            .query(`
                INSERT INTO clients ([cliente], [NOMBRE], [RFC], [CP], [PAIS])
                VALUES (@cliente, @nombre, @rfc, @cp, 'MÉXICO')
            `);
        console.log(`✅ Cliente ${nombre} agregado a la tabla clients de SQL con código ${clienteCodigo}.`);
        return clienteCodigo;
    } catch (err) {
        console.error('Error al crear cliente en SQL:', err);
        return null;
    }
}

module.exports = {
    sql,
    connectToDatabase,
    query,
    searchProducts,
    createSqlClient
};
