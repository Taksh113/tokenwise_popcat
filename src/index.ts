// src/index.ts

import { fetchTopHolders } from './solana';
import { monitorTransactions } from './tracker';
// import { fetchTokenTransactionsForTopHolders } from './tracker';
import { fetchHistoricalTransactions } from './history';
import { initDB } from './db';

async function main() {
  try {
    // Initialize the database
    await initDB();
    console.log("Database initialized.");

    // Fetch the top 30 holders of the token
    await fetchTopHolders();
    console.log("Fetched top holders.");

    // Monitor token transactions for these top holders
    await monitorTransactions();
    console.log("Started monitoring transactions.");

    // Example: Fetch historical transactions for the past 7 days
    const now = new Date();
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(now.getDate() - 1);

    // Fetch historical transactions from the database
    await fetchHistoricalTransactions(sevenDaysAgo, now);
    console.log(`Fetched historical transactions from ${sevenDaysAgo.toISOString()} to ${now.toISOString()}.`);

  } catch (error) {
    console.error("An error occurred:", error);
  }
}

main().catch(console.error);
