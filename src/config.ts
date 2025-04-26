import dotenv from 'dotenv';
dotenv.config();

export const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
export const TOKEN_ADDRESS = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
export const TOP_HOLDER_COUNT = 30;
