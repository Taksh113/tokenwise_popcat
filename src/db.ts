import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

// Open database and ensure correct type is used
export async function openDB(): Promise<Database> {
  return open({
    filename: './tokenwise.db',
    driver: sqlite3.Database
  });
}

// Initialize database with tables
export async function initDB() {
  const db = await openDB();
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS holders (
      address TEXT PRIMARY KEY,
      balance REAL
    );
  `);
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      signature TEXT UNIQUE,
      type TEXT NOT NULL,  -- 'buy' or 'sell'
      amount REAL NOT NULL,
      protocol TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      price REAL NOT NULL   -- Add this line to store the price
    );
  `);
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS all_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      signature TEXT UNIQUE,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      protocol TEXT,
      timestamp INTEGER,
      price REAL NOT NULL   -- Add this line to store the price
    );
  `);

  
}

// export async function initDB() {
//   const db = await openDB();

//   await db.exec(`
//     CREATE TABLE IF NOT EXISTS holders (
//       address TEXT PRIMARY KEY,
//       balance REAL
//     );
//   `);

//   await db.exec(`
//     CREATE TABLE IF NOT EXISTS transactions (
//       tx_signature TEXT PRIMARY KEY,
//       wallet TEXT,
//       timestamp INTEGER,
//       amount REAL,
//       type TEXT -- 'send' or 'receive'
//     );
//   `);
  
  // await db.exec(`
  //   CREATE TABLE IF NOT EXISTS transactions (
  //     id INTEGER PRIMARY KEY AUTOINCREMENT,
  //     wallet_address TEXT,
  //     type TEXT, -- 'buy' or 'sell'
  //     amount REAL,
  //     usd_value REAL, -- USD value at transaction time
  //     protocol TEXT,
  //     timestamp INTEGER
  //   );
  // `);
// }
