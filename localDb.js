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
                    sql_pedido_id INTEGER,
                    status TEXT DEFAULT 'pending', -- pending, finalized
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (client_phone) REFERENCES clients(phone)
                );

                CREATE TABLE IF NOT EXISTS quote_details (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    quote_id INTEGER,
                    articulo TEXT,
                    descrip TEXT,
                    cantidad INTEGER,
                    precio_unitario REAL,
                    monto_iva REAL,
                    total_unitario REAL,
                    impuesto TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS promotions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    text TEXT,
                    image_url TEXT,
                    position TEXT, -- WELCOME, POST_NAME, PRE_QUOTE
                    active INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS campaigns (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    text TEXT,
                    image_url TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

async function getAllClients() {
    const db = await getLocalDb();
    return db.all('SELECT * FROM clients');
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
async function addItemToQuote(phone, articulo, descrip, cantidad, precio_unitario, monto_iva, total_unitario, impuesto) {
    const db = await getLocalDb();
    
    let quoteId = await getActiveQuoteId(db, phone);
    
    if (!quoteId) {
        const result = await db.run('INSERT INTO quotes (client_phone, status) VALUES (?, "pending")', [phone]);
        quoteId = result.lastID;
    }

    await db.run(
        'INSERT INTO quote_details (quote_id, articulo, descrip, cantidad, precio_unitario, monto_iva, total_unitario, impuesto) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [quoteId, articulo, descrip, cantidad, precio_unitario, monto_iva, total_unitario, impuesto]
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

// Finalizar la cotización (Cambia estado de la cabecera y guarda el ID de SQL)
async function finalizeQuote(phone, sqlPedidoId) {
    const db = await getLocalDb();
    await db.run('UPDATE quotes SET status = "finalized", sql_pedido_id = ? WHERE client_phone = ? AND status = "pending"', [sqlPedidoId, phone]);
}

// ========================
// Módulo de Promociones
// ========================

async function getActivePromotions(position) {
    const db = await getLocalDb();
    return db.all('SELECT * FROM promotions WHERE position = ? AND active = 1', [position]);
}

async function getAllPromotions() {
    const db = await getLocalDb();
    return db.all('SELECT * FROM promotions ORDER BY created_at DESC');
}

async function addPromotion(text, image_url, position) {
    const db = await getLocalDb();
    await db.run('INSERT INTO promotions (text, image_url, position) VALUES (?, ?, ?)', [text, image_url, position]);
}

async function updatePromotion(id, active) {
    const db = await getLocalDb();
    await db.run('UPDATE promotions SET active = ? WHERE id = ?', [active, id]);
}

async function deletePromotion(id) {
    const db = await getLocalDb();
    await db.run('DELETE FROM promotions WHERE id = ?', [id]);
}

// ========================
// Módulo de Campañas
// ========================

async function addCampaign(text, image_url) {
    const db = await getLocalDb();
    await db.run('INSERT INTO campaigns (text, image_url) VALUES (?, ?)', [text, image_url]);
}

async function getAllCampaigns() {
    const db = await getLocalDb();
    return db.all('SELECT * FROM campaigns ORDER BY created_at DESC');
}

async function deleteCampaign(id) {
    const db = await getLocalDb();
    await db.run('DELETE FROM campaigns WHERE id = ?', [id]);
}

// ========================
// Módulo de Analítica
// ========================

async function getAnalyticsStats() {
    const db = await getLocalDb();
    
    // Total de cotizaciones finalizadas
    const totalQuotes = await db.get('SELECT COUNT(*) as count FROM quotes WHERE status = "finalized"');
    
    // Productos más cotizados (Top 10)
    const topProducts = await db.all(`
        SELECT descrip, COUNT(*) as count 
        FROM quote_details 
        GROUP BY descrip 
        ORDER BY count DESC 
        LIMIT 10
    `);

    // Actividad diaria (últimos 7 días)
    const dailyActivity = await db.all(`
        SELECT DATE(created_at) as date, COUNT(*) as count 
        FROM quotes 
        WHERE status = "finalized" 
        GROUP BY DATE(created_at) 
        ORDER BY date DESC 
        LIMIT 7
    `);

    // Clientes únicos
    const totalClients = await db.get('SELECT COUNT(*) as count FROM clients');

    return {
        totalQuotes: totalQuotes.count,
        topProducts,
        dailyActivity: dailyActivity.reverse(),
        totalClients: totalClients.count
    };
}

module.exports = {
    getLocalDb,
    getUser,
    createUser,
    updateUserCode,
    addItemToQuote,
    getPendingQuote,
    clearPendingQuote,
    finalizeQuote,
    getActivePromotions,
    getAllPromotions,
    addPromotion,
    updatePromotion,
    deletePromotion,
    getAnalyticsStats,
    getAllClients,
    addCampaign,
    getAllCampaigns,
    deleteCampaign
};
