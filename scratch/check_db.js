const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

async function clean() {
    const db = await open({
        filename: './local_bot.db',
        driver: sqlite3.Database
    });
    await db.run('DELETE FROM clients');
    await db.run('DELETE FROM quotes');
    await db.run('DELETE FROM quote_details');
    console.log('Base de datos limpiada.');
}

clean();
