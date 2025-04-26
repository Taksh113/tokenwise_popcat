import { openDB } from './db';

export async function fetchHistoricalTransactions(startDate: Date, endDate: Date) {
  const db = await openDB();

  const start = startDate.getTime();
  const end = endDate.getTime();

  const rows = await db.all(
    `SELECT * FROM transactions WHERE timestamp BETWEEN ? AND ?`,
    [start, end]
  );

  console.log(`Found ${rows.length} historical transactions.`);
  console.table(rows);
}
