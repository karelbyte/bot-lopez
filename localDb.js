const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

let dbPromise = null;

async function getLocalDb() {
    if (!dbPromise) {
        dbPromise = open({
            filename: './local_bot.db',
            driver: sqlite3.Database
        }).then(async (db) => {
            // Activar Foreign Keys en SQLite
            await db.exec('PRAGMA foreign_keys = ON;');
            
            // Crear tablas normalizadas
            await db.exec(`
                CREATE TABLE IF NOT EXISTS clients (
                    phone TEXT PRIMARY KEY,
                    name TEXT,
                    cliente_id TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS quotes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    client_phone TEXT,
                    status TEXT DEFAULT 'pending', -- pending, finalized
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (client_phone) REFERENCES clients(phone)
                );

                CREATE TABLE IF NOT EXISTS quote_details (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    quote_id INTEGER,
                    articulo TEXT,
                    descrip TEXT,
                    precio REAL,
                    cantidad INTEGER,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE
                );
            `);

            return db;
        });
    }
    return dbPromise;
}

// ========================
// Módulo de Clientes
// ========================
async function getUser(phone) {
    const db = await getLocalDb();
    return db.get('SELECT * FROM clients WHERE phone = ?', [phone]);
}

async function createUser(phone, name) {
    const db = await getLocalDb();
    await db.run('INSERT OR REPLACE INTO clients (phone, name) VALUES (?, ?)', [phone, name]);
}

async function updateUserCode(phone, code) {
    const db = await getLocalDb();
    await db.run('UPDATE clients SET cliente_id = ? WHERE phone = ?', [code, phone]);
}

// ========================
// Módulo de Cotizaciones
// ========================

// Obtener la cotización pendiente actual del cliente
async function getActiveQuoteId(db, phone) {
    const quote = await db.get('SELECT id FROM quotes WHERE client_phone = ? AND status = "pending"', [phone]);
    return quote ? quote.id : null;
}

// Agregar un artículo a la cotización (crea la cabecera si no existe)
async function addItemToQuote(phone, articulo, descrip, precio, cantidad) {
    const db = await getLocalDb();
    
    let quoteId = await getActiveQuoteId(db, phone);
    
    if (!quoteId) {
        const result = await db.run('INSERT INTO quotes (client_phone, status) VALUES (?, "pending")', [phone]);
        quoteId = result.lastID;
    }

    await db.run(
        'INSERT INTO quote_details (quote_id, articulo, descrip, precio, cantidad) VALUES (?, ?, ?, ?, ?)',
        [quoteId, articulo, descrip, precio, cantidad]
    );
}

// Obtener todos los detalles de la cotización pendiente
async function getPendingQuote(phone) {
    const db = await getLocalDb();
    const quoteId = await getActiveQuoteId(db, phone);
    
    if (!quoteId) return [];

    return db.all('SELECT * FROM quote_details WHERE quote_id = ?', [quoteId]);
}

// Borrar la cotización pendiente (Cascada borra los detalles)
async function clearPendingQuote(phone) {
    const db = await getLocalDb();
    await db.run('DELETE FROM quotes WHERE client_phone = ? AND status = "pending"', [phone]);
}

// Finalizar la cotización (Cambia estado de la cabecera)
async function finalizeQuote(phone) {
    const db = await getLocalDb();
    await db.run('UPDATE quotes SET status = "finalized" WHERE client_phone = ? AND status = "pending"', [phone]);
}

module.exports = {
    getLocalDb,
    getUser,
    createUser,
    updateUserCode,
    addItemToQuote,
    getPendingQuote,
    clearPendingQuote,
    finalizeQuote
};
