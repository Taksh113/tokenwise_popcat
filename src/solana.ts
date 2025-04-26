import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { TOKEN_ADDRESS, RPC_URL, TOP_HOLDER_COUNT } from './config';
import { sleep } from './utils';
import { openDB } from './db';

const connection = new Connection(RPC_URL, 'confirmed');

export async function fetchTopHolders() {
  console.log(`Fetching Top ${TOP_HOLDER_COUNT} Holders...`);
  const db = await openDB();

  try {
    // Fetch all token accounts for the token's mint address
    const mintPubkey = new PublicKey(TOKEN_ADDRESS);
    const response = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [
        {
          dataSize: 165, // Size of a token account
        },
        {
          memcmp: {
            offset: 0, // Mint address is at the start of the account data
            bytes: mintPubkey.toBase58(),
          },
        },
      ],
    });

    console.log(`Retrieved ${response.length} token accounts from RPC`);

    // Parse token accounts and extract balance and owner
    const accounts = response
      .map(({ account, pubkey }) => {
        // Token account layout: mint (32 bytes), owner (32 bytes), amount (8 bytes), etc.
        const amount = account.data.readBigUInt64LE(64); // Balance at offset 64
        const owner = new PublicKey(account.data.slice(32, 64)).toBase58(); // Owner at offset 32
        return { address: pubkey.toBase58(), owner, balance: Number(amount) };
      })
      .filter((account) => account.balance > 0); // Exclude accounts with zero balance

    // Sort by balance (descending) and take top TOP_HOLDER_COUNT
    const topHolders = accounts
      .sort((a, b) => b.balance - a.balance)
      .slice(0, TOP_HOLDER_COUNT);

    console.log(`Processing ${topHolders.length} top holders`);

    for (const account of topHolders) {
      // Convert balance to human-readable format (assuming token decimals)
      const balance = account.balance / 1_000_000_000; // Adjust based on token decimals (e.g., 9)

      console.log(`Address: ${account.owner}, Balance: ${balance}`);

      await db.run(
        `INSERT OR REPLACE INTO holders (address, balance) VALUES (?, ?)`,
        [account.owner, balance]
      );
      await sleep(200); // Avoid rate limiting
    }

    if (topHolders.length < TOP_HOLDER_COUNT) {
      console.warn(
        `Only ${topHolders.length} accounts found, less than requested ${TOP_HOLDER_COUNT}`
      );
    }

    console.log('✅ Top Holders Fetched and Saved.');
  } catch (error: any) {
    console.error('Error fetching top holders:', error);
    throw error;
  }
}

