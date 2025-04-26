import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  ParsedInstruction,
  PartiallyDecodedInstruction,
} from '@solana/web3.js';
import { openDB } from './db';
import { RPC_URL, TOKEN_ADDRESS } from './config';
import { sleep } from './utils';
import axios from 'axios';



const connection = new Connection(RPC_URL, 'confirmed');



export async function monitorTransactions() {
  const db = await openDB();
  const holders = await db.all(`SELECT address FROM holders ORDER BY balance DESC`);

  console.log('Monitoring Transactions...');

  for (const holder of holders) {
    const pubKey = new PublicKey(holder.address);
    let retries = 3;
    while (retries > 0) {
      try {
        const signatures = await connection.getSignaturesForAddress(pubKey, { limit: 100 });
        for (const sig of signatures) {
          const tx = await connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          });
          if (tx) {
            console.log(`Processing transaction ${sig.signature} for ${holder.address}`);
            await processTransaction(tx, holder.address, sig.signature);
          }
          await sleep(200);
        }
        break;
      } catch (error: any) {
        if (error.message.includes('429')) {
          console.log('Server responded with 429 Too Many Requests. Retrying after 500ms...');
          await sleep(500);
          retries--;
        } else {
          console.error(`Error processing transactions for ${holder.address}:`, error);
          break;
        }
      }
    }
    await sleep(500);
  }
}


export async function getTokenPrice(timestamp: number): Promise<number> {
  try {
    // Convert timestamp to date in dd-mm-yyyy format
    const date = new Date(timestamp); // Use timestamp directly as it's already in milliseconds
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are zero-indexed
    const year = date.getFullYear();
    const formattedDate = `${day}-${month}-${year}`;

    // Build the URL for the CoinGecko API
    const url = `https://api.coingecko.com/api/v3/coins/popcat/history?date=${formattedDate}`;

    // Fetch data from CoinGecko API
    const response = await axios.get(url);

    // Extract the price from the response
    if (response.data && response.data.market_data && response.data.market_data.current_price) {
      const price = response.data.market_data.current_price.usd;
      console.log(`Fetched POPCAT price from CoinGecko for ${formattedDate}: $${price}`);
      return price;
    } else {
      console.warn('POPCAT price data not found.');
    }
  } catch (error) {
    console.error('Failed to fetch POPCAT price from CoinGecko:', error);
  }

  return 0;
}

async function processTransaction(
  tx: ParsedTransactionWithMeta | null,
  walletAddress: string,
  signature: string
) {
  if (!tx || !tx.meta) {
    console.log(`Skipping transaction ${signature}: No transaction or meta data`);
    return;
  }

  const db = await openDB();
  let protocol = 'Unknown';
  let type = 'unknown';
  let amount = 0;
  let price = 0;
  let tokenMintAddress: string | undefined = undefined;
  let detected = false;

  const instructions: (ParsedInstruction | PartiallyDecodedInstruction)[] = tx.transaction.message.instructions;
  const innerInstructions = tx.meta.innerInstructions || [];
  const preBalances = tx.meta.preTokenBalances || [];
  const postBalances = tx.meta.postTokenBalances || [];
  const preSolBalances = tx.meta.preBalances || [];
  const postSolBalances = tx.meta.postBalances || [];
  const accountKeys = tx.transaction.message.accountKeys.map((key) => key.pubkey.toBase58());


  // Detect protocol
  for (const ix of instructions) {
    if ('programId' in ix && ix.programId) {
      const program = ix.programId.toBase58();
      if (program === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') protocol = 'Jupiter';
      if (program === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') protocol = 'Raydium';
      if (program === '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP') protocol = 'Orca';
    }
  }

  // 1. Try detecting SPL Token transfer from inner instructions
  for (const inner of innerInstructions) {
    for (const ix of inner.instructions) {
      if ('parsed' in ix && ix.parsed?.type === 'transfer') {
        const parsedInfo = ix.parsed.info;
        // const transferAmount = parseFloat(parsedInfo.tokenAmount.uiAmountString || '0');
        const transferAmount = parsedInfo.tokenAmount?.uiAmountString ? parseFloat(parsedInfo.tokenAmount.uiAmountString) : 0;


        if (parsedInfo.destination === walletAddress) {
          type = 'buy';
          amount = transferAmount;
          tokenMintAddress = parsedInfo.mint;
          detected = true;
          break;
        } else if (parsedInfo.source === walletAddress) {
          type = 'sell';
          amount = transferAmount;
          tokenMintAddress = parsedInfo.mint;
          detected = true;
          break;
        }
      }
    }
    if (detected) break;
  }

  // 2. If not detected, fallback to token balance differences
  if (!detected) {
    for (const postBalance of postBalances) {
      const matchingPre = preBalances.find(
        (pre) => pre.mint === postBalance.mint && pre.owner === postBalance.owner
      );

      const preAmount = matchingPre ? parseFloat(matchingPre.uiTokenAmount.uiAmountString || '0') : 0;
      const postAmount = parseFloat(postBalance.uiTokenAmount.uiAmountString || '0');

      if (postAmount > preAmount) {
        type = 'buy';
        amount = postAmount - preAmount;
        tokenMintAddress = postBalance.mint;
        detected = true;
      } else if (postAmount < preAmount) {
        type = 'sell';
        amount = preAmount - postAmount;
        tokenMintAddress = postBalance.mint;
        detected = true;
      }
    }
  }

  // 3. If still not detected, check SOL transfer
  if (!detected) {
    const index = accountKeys.findIndex(key => key === walletAddress);
    if (index !== -1) {
      const preLamports = preSolBalances[index];
      const postLamports = postSolBalances[index];
      const lamportDifference = postLamports - preLamports;

      if (lamportDifference > 0) {
        type = 'buy';
        amount = lamportDifference / 1e9;
        tokenMintAddress = 'SOL';
        detected = true;
      } else if (lamportDifference < 0) {
        type = 'sell';
        amount = -lamportDifference / 1e9;
        tokenMintAddress = 'SOL';
        detected = true;
      }
    }
  }

  const timestamp = (tx.blockTime || 0) * 1000;
  
  if (detected && tokenMintAddress) {
    await db.run(
      `INSERT INTO all_transactions (wallet_address, signature, type, amount, protocol, timestamp, price)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [walletAddress, signature, type, amount, protocol, timestamp, price]
    );

    if (tokenMintAddress === TOKEN_ADDRESS) {
      price = await getTokenPrice(timestamp);
      await db.run(
        `INSERT INTO transactions (wallet_address, signature, type, amount, protocol, timestamp, price)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
         [walletAddress, signature, type, amount, protocol, timestamp, price]
      );
      console.log(`✅ Recorded POPCAT ${type} of ${amount} at $${price} on ${protocol}`);
    } else if (tokenMintAddress === 'SOL') {
      console.log(`✅ Recorded ${type} of ${amount} SOL`);
    } else {
      console.log(`✅ Recorded ${type} of ${amount} tokens (Mint: ${tokenMintAddress})`);
    }
  } else {
    console.log(`⚠️ Could not detect any token/SOL movement in transaction ${signature}, the tx is failed`);
  }
}

// import {
//   Connection,
//   PublicKey,
//   ParsedTransactionWithMeta,
//   ParsedInstruction,
//   PartiallyDecodedInstruction,
// } from '@solana/web3.js';
// import {
//   getAssociatedTokenAddress,
//   TOKEN_PROGRAM_ID,
// } from '@solana/spl-token';
// import { openDB } from './db';
// import { RPC_URL, TOKEN_ADDRESS } from './config';
// import { sleep } from './utils';

// const connection = new Connection(RPC_URL, 'confirmed');

// export async function monitorTransactions() {
//   const db = await openDB();
//   const holders = await db.all(`SELECT address FROM holders ORDER BY balance DESC`);

//   console.log('Monitoring Transactions...');

//   for (const holder of holders) {
//     const pubKey = new PublicKey(holder.address);
//     let retries = 3;
//     while (retries > 0) {
//       try {
//         const signatures = await connection.getSignaturesForAddress(pubKey, { limit: 100 });
//         for (const sig of signatures) {
//           const tx = await connection.getParsedTransaction(sig.signature, {
//             maxSupportedTransactionVersion: 0,
//           });
//           if (tx) {
//             console.log(`Processing transaction ${sig.signature} for ${holder.address}`);
//             await processTransaction(tx, holder.address, sig.signature);
//           }
//           await sleep(200);
//         }
//         break;
//       } catch (error: any) {
//         if (error.message.includes('429')) {
//           console.log('Server responded with 429 Too Many Requests. Retrying after 500ms...');
//           await sleep(500);
//           retries--;
//         } else {
//           console.error(`Error processing transactions for ${holder.address}:`, error);
//           break;
//         }
//       }
//     }
//     await sleep(500);
//   }
// }

// async function processTransaction(
//   tx: ParsedTransactionWithMeta | null,
//   walletAddress: string,
//   signature: string
// ) {
//   if (!tx || !tx.meta) {
//     console.log(`Skipping transaction ${signature}: No transaction or meta data`);
//     return;
//   }

//   const db = await openDB();
//   let protocol = 'Unknown';
//   let type = 'unknown';
//   let amount = 0;

//   const instructions: (ParsedInstruction | PartiallyDecodedInstruction)[] =
//     tx.transaction.message.instructions;

//   for (const ix of instructions) {
//     if ('programId' in ix && ix.programId) {
//       const program = ix.programId.toBase58();
//       if (program === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') protocol = 'Jupiter';
//       if (program === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') protocol = 'Raydium';
//       if (program === '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP') protocol = 'Orca';
//     }
//   }

//   console.log(`Transaction ${signature}: Protocol detected: ${protocol}`);

//   const tokenAddress = TOKEN_ADDRESS;
//   const walletPubKey = new PublicKey(walletAddress);

//   // Get associated token address for the wallet
//   const ata = await getAssociatedTokenAddress(new PublicKey(tokenAddress), walletPubKey);

//   const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubKey, {
//     programId: TOKEN_PROGRAM_ID,
//   });
//   const relevantTokenAccounts = tokenAccounts.value
//     .filter((acc) => acc.account.data.parsed.info.mint === tokenAddress)
//     .map((acc) => acc.pubkey.toBase58());

//   const isOwnerMatch = (owner: string) =>
//     owner === walletAddress || relevantTokenAccounts.includes(owner);

//   const preBalances = tx.meta.preTokenBalances || [];
//   const postBalances = tx.meta.postTokenBalances || [];
//   const innerInstructions = tx.meta.innerInstructions || [];

//   console.log(`Pre-balances for ${walletAddress}:`, preBalances);
//   console.log(`Post-balances for ${walletAddress}:`, postBalances);
//   console.log(`Inner Instructions:`, innerInstructions);

//   for (const postBalance of postBalances) {
//     if (postBalance.mint === tokenAddress && isOwnerMatch(postBalance.owner ?? '')) {
//       const preBalance = preBalances.find(
//         (pre) => pre.mint === tokenAddress && isOwnerMatch(pre.owner ?? '')
//       );
  
//       // Ensure uiAmountString is a valid string or fallback to '0'
//       const postAmount = parseFloat(postBalance.uiTokenAmount.uiAmountString ?? '0');
//       const preAmount = preBalance
//         ? parseFloat(preBalance.uiTokenAmount.uiAmountString ?? '0')
//         : 0;
  
//       console.log(
//         `Balance change for ${walletAddress}: Pre=${preAmount}, Post=${postAmount}`
//       );
  
//       if (postAmount > preAmount) {
//         type = 'buy';
//         amount = postAmount - preAmount;
//       } else if (postAmount < preAmount) {
//         type = 'sell';
//         amount = preAmount - postAmount;
//       }
//     }
//   }
//   for (const inner of innerInstructions) {
//     for (const ix of inner.instructions) {
//       if ('parsed' in ix && ix.parsed && ix.parsed.type === 'transfer') {
//         const parsedInfo = ix.parsed.info;
//         console.log(`Inner transfer instruction:`, parsedInfo);
//         if (parsedInfo.mint === tokenAddress) {
//           const transferAmount = parseFloat(parsedInfo.tokenAmount.uiAmountString || '0');
//           if (isOwnerMatch(parsedInfo.destination)) {
//             type = 'buy';
//             amount = transferAmount;
//           } else if (isOwnerMatch(parsedInfo.source)) {
//             type = 'sell';
//             amount = transferAmount;
//           }
//         }
//       }
//     }
//   }

//   for (const ix of instructions) {
//     if ('parsed' in ix && ix.parsed) {
//       const parsedInfo = ix.parsed.info;
//       console.log(`Parsed instruction for ${walletAddress}:`, parsedInfo);
//       if (parsedInfo && parsedInfo.tokenAmount && parsedInfo.mint === tokenAddress) {
//         const instructionAmount = parseFloat(parsedInfo.tokenAmount.uiAmountString || '0');
//         if (parsedInfo.type === 'transfer' && isOwnerMatch(parsedInfo.destination)) {
//           type = 'buy';
//           amount = instructionAmount;
//         } else if (parsedInfo.type === 'transfer' && isOwnerMatch(parsedInfo.source)) {
//           type = 'sell';
//           amount = instructionAmount;
//         }
//       }
//     } else if ('data' in ix) {
//       const program = ix.programId.toBase58();
//       console.log(`PartiallyDecodedInstruction for ${walletAddress}:`, ix.data);
//       if (program === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') {
//         try {
//           console.log('Raydium instruction data (manual decoding needed):', ix.data);
//         } catch (error) {
//           console.log(`Failed to decode Raydium instruction: ${error}`);
//         }
//       }
//     }
//   }

//   const timestamp = (tx.blockTime || 0) * 1000;

//   // Insert only meaningful transactions
//   if (type !== 'unknown' && amount > 0) {
//     await db.run(
//       `INSERT INTO transactions (wallet_address, type, amount, protocol, timestamp)
//        VALUES (?, ?, ?, ?, ?)`,
//       [walletAddress, type, amount, protocol, timestamp]
//     );
//     console.log(
//       `Recorded ${type} transaction for ${walletAddress}: ${amount} tokens on ${protocol} (Signature: ${signature})`
//     );
//   } else {
//     console.log(
//       `Skipped transaction ${signature} for ${walletAddress}: Type=${type}, Amount=${amount}`
//     );
//     console.log(`DEBUG SKIP: tx=${signature} for ${walletAddress}`);
//     console.log(JSON.stringify(tx, null, 2));
//   }
// }

// import {
//   Connection,
//   PublicKey,
//   ParsedTransactionWithMeta,
//   ParsedInstruction,
//   PartiallyDecodedInstruction,
// } from '@solana/web3.js';
// import {
//   getAssociatedTokenAddress,
//   TOKEN_PROGRAM_ID,
// } from '@solana/spl-token';
// import { openDB } from './db';
// import { RPC_URL, TOKEN_ADDRESS } from './config';
// import { sleep } from './utils';
// import { getPythProgramKeyForCluster, PythHttpClient } from '@pythnetwork/client';
// import bs58 from 'bs58';

// const connection = new Connection(RPC_URL, 'confirmed');
// const pythProgramKey = getPythProgramKeyForCluster('mainnet-beta');
// const pythClient = new PythHttpClient(connection, pythProgramKey);

// const POPCAT_FEED_ID_HEX = 'b9312a7ee50e189ef045aa3c7842e099b061bd9bdc99ac645956c3b660dc8cce';

// // Convert Hexadecimal to Uint8Array
// const feedIdUint8Array = Buffer.from(POPCAT_FEED_ID_HEX, 'hex');

// // Convert Uint8Array to base58
// const POPCAT_FEED_ID = new PublicKey(bs58.encode(feedIdUint8Array));

// export async function monitorTransactions() {
//   const db = await openDB();
//   const holders = await db.all(`SELECT address FROM holders ORDER BY balance DESC`);

//   console.log('Monitoring Transactions...');

//   for (const holder of holders) {
//     const pubKey = new PublicKey(holder.address);
//     let retries = 3;
//     while (retries > 0) {
//       try {
//         const signatures = await connection.getSignaturesForAddress(pubKey, { limit: 100 });
//         for (const sig of signatures) {
//           const tx = await connection.getParsedTransaction(sig.signature, {
//             maxSupportedTransactionVersion: 0,
//           });
//           if (tx) {
//             console.log(`Processing transaction ${sig.signature} for ${holder.address}`);
//             await processTransaction(tx, holder.address, sig.signature);
//           }
//           await sleep(200);
//         }
//         break;
//       } catch (error: any) {
//         if (error.message.includes('429')) {
//           console.log('Server responded with 429 Too Many Requests. Retrying after 500ms...');
//           await sleep(500);
//           retries--;
//         } else {
//           console.error(`Error processing transactions for ${holder.address}:`, error);
//           break;
//         }
//       }
//     }
//     await sleep(500);
//   }
// }

// export async function getTokenPrice(): Promise<number> {
//   try {
//     const data = await pythClient.getData();
    
//     // Loop through products array to find the product matching the POPCAT_FEED_ID
//     const priceData = data.products.find(product => product.id === POPCAT_FEED_ID.toBase58());

//     if (priceData && priceData.price !== undefined) {
//       // Convert price to a number before returning
//       const price = parseFloat(priceData.price.toString());
//       console.log(`Fetched POPCAT price from Pyth: $${price}`);
//       return price;
//     } else {
//       console.warn('POPCAT price data not found.');
//     }
//   } catch (error) {
//     console.error('Failed to fetch POPCAT price from Pyth:', error);
//   }

//   return 0;
// }


// async function processTransaction(
//   tx: ParsedTransactionWithMeta | null,
//   walletAddress: string,
//   signature: string
// ) {
//   if (!tx || !tx.meta) {
//     console.log(`Skipping transaction ${signature}: No transaction or meta data`);
//     return;
//   }

//   const db = await openDB();
//   let protocol = 'Unknown';
//   let type = 'unknown';
//   let amount = 0;
//   let price = 0;

//   const instructions: (ParsedInstruction | PartiallyDecodedInstruction)[] = tx.transaction.message.instructions;

//   for (const ix of instructions) {
//     if ('programId' in ix && ix.programId) {
//       const program = ix.programId.toBase58();
//       if (program === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') protocol = 'Jupiter';
//       if (program === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') protocol = 'Raydium';
//       if (program === '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP') protocol = 'Orca';
//     }
//   }

//   console.log(`Transaction ${signature}: Protocol detected: ${protocol}`);

//   const tokenAddress = TOKEN_ADDRESS;
//   const walletPubKey = new PublicKey(walletAddress);

//   const ata = await getAssociatedTokenAddress(new PublicKey(tokenAddress), walletPubKey);
//   const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubKey, {
//     programId: TOKEN_PROGRAM_ID,
//   });

//   const relevantTokenAccounts = tokenAccounts.value
//     .filter((acc) => acc.account.data.parsed.info.mint === tokenAddress)
//     .map((acc) => acc.pubkey.toBase58());

//   const isOwnerMatch = (owner: string) =>
//     owner === walletAddress || relevantTokenAccounts.includes(owner);

//   const preBalances = tx.meta.preTokenBalances || [];
//   const postBalances = tx.meta.postTokenBalances || [];
//   const innerInstructions = tx.meta.innerInstructions || [];

//   console.log(`Pre-balances for ${walletAddress}:`, preBalances);
//   console.log(`Post-balances for ${walletAddress}:`, postBalances);
//   console.log(`Inner Instructions:`, innerInstructions);

//   for (const postBalance of postBalances) {
//     if (postBalance.mint === tokenAddress && isOwnerMatch(postBalance.owner ?? '')) {
//       const preBalance = preBalances.find(
//         (pre) => pre.mint === tokenAddress && isOwnerMatch(pre.owner ?? '')
//       );

//       const postAmount = parseFloat(postBalance.uiTokenAmount.uiAmountString ?? '0');
//       const preAmount = preBalance
//         ? parseFloat(preBalance.uiTokenAmount.uiAmountString ?? '0')
//         : 0;

//       console.log(
//         `Balance change for ${walletAddress}: Pre=${preAmount}, Post=${postAmount}`
//       );

//       if (postAmount > preAmount) {
//         type = 'buy';
//         amount = postAmount - preAmount;
//       } else if (postAmount < preAmount) {
//         type = 'sell';
//         amount = preAmount - postAmount;
//       }
//     }
//   }

//   for (const inner of innerInstructions) {
//     for (const ix of inner.instructions) {
//       if ('parsed' in ix && ix.parsed && ix.parsed.type === 'transfer') {
//         const parsedInfo = ix.parsed.info;
//         console.log(`Inner transfer instruction:`, parsedInfo);
//         if (parsedInfo.mint === tokenAddress) {
//           const transferAmount = parseFloat(parsedInfo.tokenAmount.uiAmountString || '0');
//           if (isOwnerMatch(parsedInfo.destination)) {
//             type = 'buy';
//             amount = transferAmount;
//           } else if (isOwnerMatch(parsedInfo.source)) {
//             type = 'sell';
//             amount = transferAmount;
//           }
//         }
//       }
//     }
//   }

//   for (const ix of instructions) {
//     if ('parsed' in ix && ix.parsed) {
//       const parsedInfo = ix.parsed.info;
//       console.log(`Parsed instruction for ${walletAddress}:`, parsedInfo);
//       if (parsedInfo && parsedInfo.tokenAmount && parsedInfo.mint === tokenAddress) {
//         const instructionAmount = parseFloat(parsedInfo.tokenAmount.uiAmountString || '0');
//         if (parsedInfo.type === 'transfer' && isOwnerMatch(parsedInfo.destination)) {
//           type = 'buy';
//           amount = instructionAmount;
//         } else if (parsedInfo.type === 'transfer' && isOwnerMatch(parsedInfo.source)) {
//           type = 'sell';
//           amount = instructionAmount;
//         }
//       }
//     } else if ('data' in ix) {
//       const program = ix.programId.toBase58();
//       console.log(`PartiallyDecodedInstruction for ${walletAddress}:`, ix.data);
//       if (program === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') {
//         try {
//           console.log('Raydium instruction data (manual decoding needed):', ix.data);
//         } catch (error) {
//           console.log(`Failed to decode Raydium instruction: ${error}`);
//         }
//       }
//     }
//   }

//   const timestamp = (tx.blockTime || 0) * 1000;

//   if (type !== 'unknown' && amount > 0) {
//     price = await getTokenPrice();  // Get the latest token price
//     await db.run(
//       `INSERT INTO transactions (wallet_address, type, amount, protocol, timestamp, price)
//        VALUES (?, ?, ?, ?, ?, ?)`,
//       [walletAddress, type, amount, protocol, timestamp, price]
//     );
//     console.log(
//       `Recorded ${type} transaction for ${walletAddress}: ${amount} tokens at $${price} on ${protocol} (Signature: ${signature})`
//     );
//   } else {
//     console.log(
//       `Skipped transaction ${signature} for ${walletAddress}: Type=${type}, Amount=${amount}`
//     );
//     console.log(`DEBUG SKIP: tx=${signature} for ${walletAddress}`);
//     console.log(JSON.stringify(tx, null, 2));
//   }
//   await db.run(
//     `INSERT INTO all_transactions (wallet_address, signature, protocol, timestamp, note)
//      VALUES (?, ?, ?, ?, ?)`,
//     [walletAddress, signature, protocol, timestamp, (type === 'unknown' ? 'no matching token activity' : 'token transaction recorded')]
//   );
// }
// BEST ONE

// Updated full code for tracking transactions of **all tokens** and separating POPCAT ones

// import {
//   Connection,
//   PublicKey,
//   ParsedTransactionWithMeta,
//   ParsedInstruction,
//   PartiallyDecodedInstruction,
// } from '@solana/web3.js';
// // import {
// //   getAssociatedTokenAddress,
// //   TOKEN_PROGRAM_ID,
// // } from '@solana/spl-token';
// import { openDB } from './db';
// import { RPC_URL, TOKEN_ADDRESS } from './config';
// import { sleep } from './utils';
// import { getPythProgramKeyForCluster, PythHttpClient } from '@pythnetwork/client';
// import bs58 from 'bs58';

// const connection = new Connection(RPC_URL, 'confirmed');
// const pythProgramKey = getPythProgramKeyForCluster('mainnet-beta');
// const pythClient = new PythHttpClient(connection, pythProgramKey);

// const POPCAT_FEED_ID_HEX = 'b9312a7ee50e189ef045aa3c7842e099b061bd9bdc99ac645956c3b660dc8cce';

// // Convert Hexadecimal to Uint8Array
// const feedIdUint8Array = Buffer.from(POPCAT_FEED_ID_HEX, 'hex');

// // Convert Uint8Array to base58
// const POPCAT_FEED_ID = new PublicKey(bs58.encode(feedIdUint8Array));

// export async function monitorTransactions() {
//   const db = await openDB();
//   const holders = await db.all(`SELECT address FROM holders ORDER BY balance DESC`);

//   console.log('Monitoring Transactions...');

//   for (const holder of holders) {
//     const pubKey = new PublicKey(holder.address);
//     let retries = 3;
//     while (retries > 0) {
//       try {
//         const signatures = await connection.getSignaturesForAddress(pubKey, { limit: 100 });
//         for (const sig of signatures) {
//           const tx = await connection.getParsedTransaction(sig.signature, {
//             maxSupportedTransactionVersion: 0,
//           });
//           if (tx) {
//             console.log(`Processing transaction ${sig.signature} for ${holder.address}`);
//             await processTransaction(tx, holder.address, sig.signature);
//           }
//           await sleep(200);
//         }
//         break;
//       } catch (error: any) {
//         if (error.message.includes('429')) {
//           console.log('Server responded with 429 Too Many Requests. Retrying after 500ms...');
//           await sleep(500);
//           retries--;
//         } else {
//           console.error(`Error processing transactions for ${holder.address}:`, error);
//           break;
//         }
//       }
//     }
//     await sleep(500);
//   }
// }

// export async function getTokenPrice(): Promise<number> {
//   try {
//     const data = await pythClient.getData();
    
//     // Loop through products array to find the product matching the POPCAT_FEED_ID
//     const priceData = data.products.find(product => product.id === POPCAT_FEED_ID.toBase58());

//     if (priceData && priceData.price !== undefined) {
//       // Convert price to a number before returning
//       const price = parseFloat(priceData.price.toString());
//       console.log(`Fetched POPCAT price from Pyth: $${price}`);
//       return price;
//     } else {
//       console.warn('POPCAT price data not found.');
//     }
//   } catch (error) {
//     console.error('Failed to fetch POPCAT price from Pyth:', error);
//   }

//   return 0;
// }

// async function processTransaction(
//   tx: ParsedTransactionWithMeta | null,
//   walletAddress: string,
//   signature: string
// ) {
//   if (!tx || !tx.meta) {
//     console.log(`Skipping transaction ${signature}: No transaction or meta data`);
//     return;
//   }

//   const db = await openDB();
//   let protocol = 'Unknown';
//   let type = 'unknown';
//   let amount = 0;
//   let price = 0;
//   let tokenMintAddress: string | undefined = undefined;
//   let detectedFromInner = false;

//   const instructions: (ParsedInstruction | PartiallyDecodedInstruction)[] = tx.transaction.message.instructions;
//   const innerInstructions = tx.meta.innerInstructions || [];

//   // Detect protocol
//   for (const ix of instructions) {
//     if ('programId' in ix && ix.programId) {
//       const program = ix.programId.toBase58();
//       if (program === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') protocol = 'Jupiter';
//       if (program === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') protocol = 'Raydium';
//       if (program === '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP') protocol = 'Orca';
//     }
//   }

//   const preBalances = tx.meta.preTokenBalances || [];
//   const postBalances = tx.meta.postTokenBalances || [];

//   // 1. Try to detect from inner transfer instructions
//   for (const inner of innerInstructions) {
//     for (const ix of inner.instructions) {
//       if ('parsed' in ix && ix.parsed?.type === 'transfer') {
//         const parsedInfo = ix.parsed.info;
//         const transferAmount = parseFloat(parsedInfo.tokenAmount.uiAmountString || '0');

//         if (parsedInfo.destination === walletAddress) {
//           type = 'buy';
//           amount = transferAmount;
//           tokenMintAddress = parsedInfo.mint;
//           detectedFromInner = true;
//           break;
//         } else if (parsedInfo.source === walletAddress) {
//           type = 'sell';
//           amount = transferAmount;
//           tokenMintAddress = parsedInfo.mint;
//           detectedFromInner = true;
//           break;
//         }
//       }
//     }
//     if (detectedFromInner) break;
//   }

//   // 2. Fallback: if not detected from inner instructions, use pre/post balance difference
//   if (!detectedFromInner) {
//     for (const postBalance of postBalances) {
//       const matchingPre = preBalances.find(
//         (pre) => pre.mint === postBalance.mint && pre.owner === postBalance.owner
//       );

//       const preAmount = matchingPre ? parseFloat(matchingPre.uiTokenAmount.uiAmountString || '0') : 0;
//       const postAmount = parseFloat(postBalance.uiTokenAmount.uiAmountString || '0');

//       if (postAmount > preAmount) {
//         type = 'buy';
//         amount = postAmount - preAmount;
//         tokenMintAddress = postBalance.mint;
//       } else if (postAmount < preAmount) {
//         type = 'sell';
//         amount = preAmount - postAmount;
//         tokenMintAddress = postBalance.mint;
//       }
//     }
//   }

//   const timestamp = (tx.blockTime || 0) * 1000;

//   if (tokenMintAddress) {
//     // Insert into all_transactions table
//     await db.run(
//       `INSERT INTO all_transactions (wallet_address, signature, type, amount, protocol, timestamp)
//        VALUES (?, ?, ?, ?, ?, ?)`,
//       [walletAddress, signature, type, amount, protocol, timestamp]
//     );

//     // If it's POPCAT token, insert into transactions table too
//     if (tokenMintAddress === TOKEN_ADDRESS) {
//       price = await getTokenPrice();
//       await db.run(
//         `INSERT INTO transactions (wallet_address, type, amount, protocol, timestamp, price)
//          VALUES (?, ?, ?, ?, ?, ?)`,
//         [walletAddress, type, amount, protocol, timestamp, price]
//       );
//       console.log(`✅ Recorded POPCAT ${type} of ${amount} at $${price} on ${protocol}`);
//     } else {
//       console.log(`✅ Recorded ${type} of ${amount} tokens (Mint: ${tokenMintAddress})`);
//     }
//   } else {
//     // jjkkjlk
//     console.log(`⚠️ Could not detect token movement in transaction ${signature}`);
//   }
// }


// import {
//   Connection,
//   PublicKey,
//   ParsedTransactionWithMeta,
//   ParsedInstruction,
//   PartiallyDecodedInstruction,
//   ParsedAccountData,
// } from '@solana/web3.js';
// import {
//   getAssociatedTokenAddress,
//   TOKEN_PROGRAM_ID,
// } from '@solana/spl-token';
// import { openDB } from './db';
// import { RPC_URL, TOKEN_ADDRESS } from './config';
// import { sleep } from './utils';

// const connection = new Connection(RPC_URL, 'confirmed');

// export async function monitorTransactions() {
//   const db = await openDB();
//   const holders = await db.all(`SELECT address FROM holders ORDER BY balance DESC`);

//   console.log('Monitoring Transactions...');

//   for (const holder of holders) {
//     const pubKey = new PublicKey(holder.address);
//     let retries = 3;
//     while (retries > 0) {
//       try {
//         const signatures = await connection.getSignaturesForAddress(pubKey, { limit: 100 });
//         for (const sig of signatures) {
//           let tx: ParsedTransactionWithMeta | null = await connection.getParsedTransaction(sig.signature, {
//             maxSupportedTransactionVersion: 0,
//           });
//           // Retry once if innerInstructions or balances are missing
//           if (tx && (!tx.meta?.innerInstructions || !tx.meta.preTokenBalances || !tx.meta.postTokenBalances)) {
//             console.log(`Retrying transaction ${sig.signature} due to incomplete data...`);
//             await sleep(500);
//             tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' });
//           }
//           if (tx && tx.meta) {
//             console.log(`Processing transaction ${sig.signature} for ${holder.address}`);
//             await processTransaction(tx, holder.address, sig.signature);
//           }
//           await sleep(200);
//         }
//         break;
//       } catch (error: any) {
//         if (error.message.includes('429')) {
//           console.log('Server responded with 429 Too Many Requests. Retrying after 500ms...');
//           await sleep(500);
//           retries--;
//         } else {
//           console.error(`Error processing transactions for ${holder.address}:`, error);
//           break;
//         }
//       }
//     }
//     await sleep(500);
//   }
// }

// async function processTransaction(
//   tx: ParsedTransactionWithMeta | null,
//   walletAddress: string,
//   signature: string
// ) {
//   if (!tx || !tx.meta) {
//     console.log(`Skipping transaction ${signature}: No transaction or meta data`);
//     return;
//   }

//   const db = await openDB();
//   let protocol = 'Unknown';
//   let type = 'unknown';
//   let totalAmount = 0; // Use totalAmount to aggregate all detected amounts

//   const instructions: (ParsedInstruction | PartiallyDecodedInstruction)[] =
//     tx.transaction.message.instructions;

//   for (const ix of instructions) {
//     if ('programId' in ix && ix.programId) {
//       const program = ix.programId.toBase58();
//       if (program === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') protocol = 'Jupiter';
//       if (program === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') protocol = 'Raydium';
//       if (program === '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP') protocol = 'Orca';
//     }
//   }

//   console.log(`Transaction ${signature}: Protocol detected: ${protocol}`);

//   const tokenAddress = TOKEN_ADDRESS;
//   const walletPubKey = new PublicKey(walletAddress);

//   // Dynamically get associated token address and token accounts
//   const ata = await getAssociatedTokenAddress(new PublicKey(tokenAddress), walletPubKey);
//   const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubKey, {
//     programId: TOKEN_PROGRAM_ID,
//   });
//   const relevantTokenAccounts = tokenAccounts.value
//     .filter((acc) => acc.account.data.parsed.info.mint === tokenAddress)
//     .map((acc) => acc.pubkey.toBase58());

//   const isOwnerMatch = (owner: string) =>
//     owner === walletAddress || relevantTokenAccounts.includes(owner);

//   const preBalances = tx.meta.preTokenBalances || [];
//   const postBalances = tx.meta.postTokenBalances || [];
//   const innerInstructions = tx.meta.innerInstructions || [];

//   console.log(`Pre-balances for ${walletAddress}:`, preBalances);
//   console.log(`Post-balances for ${walletAddress}:`, postBalances);
//   console.log(`Inner Instructions:`, innerInstructions);

//   // Process balance changes
//   for (const postBalance of postBalances) {
//     if (postBalance.mint === tokenAddress && isOwnerMatch(postBalance.owner ?? '')) {
//       const preBalance = preBalances.find(
//         (pre) => pre.mint === tokenAddress && isOwnerMatch(pre.owner ?? '')
//       );
  
//       const postAmount = parseFloat(postBalance.uiTokenAmount.uiAmountString ?? '0');
//       const preAmount = preBalance ? parseFloat(preBalance.uiTokenAmount.uiAmountString ?? '0') : 0;
  
//       console.log(`Balance change for ${walletAddress}: Pre=${preAmount}, Post=${postAmount}`);
  
//       const balanceChange = postAmount - preAmount;
//       if (balanceChange > 0) {
//         type = 'buy';
//         totalAmount += balanceChange;
//       } else if (balanceChange < 0) {
//         type = 'sell';
//         totalAmount += Math.abs(balanceChange); // Record absolute value for sells
//       }
//     }
//   }

//   // Manually fetch balance if postBalances is empty or inconsistent
//   if (!postBalances.length && relevantTokenAccounts.length > 0) {
//     for (const tokenAccountPubkey of relevantTokenAccounts) {
//       try {
//         const accountInfo = await connection.getParsedAccountInfo(new PublicKey(tokenAccountPubkey));
//         if (accountInfo.value?.data && 'parsed' in accountInfo.value.data) {
//           const parsedData = accountInfo.value.data as ParsedAccountData;
//           const manualAmount = parseFloat(parsedData.parsed.info.tokenAmount.uiAmountString ?? '0');
//           console.log(`Manual balance fetch for ${tokenAccountPubkey}: ${manualAmount}`);
//           if (manualAmount > 0) {
//             type = 'buy'; // Assume initial deposit if no pre-balance
//             totalAmount += manualAmount;
//           }
//         }
//       } catch (error) {
//         console.log(`Failed to fetch manual balance for ${tokenAccountPubkey}:`, error);
//       }
//     }
//   }

//   // Process inner instructions
//   for (const inner of innerInstructions) {
//     for (const ix of inner.instructions) {
//       if ('parsed' in ix && ix.parsed && ix.parsed.type === 'transfer') {
//         const parsedInfo = ix.parsed.info;
//         console.log(`Inner transfer instruction:`, parsedInfo);
//         if (parsedInfo.mint === tokenAddress) {
//           const transferAmount = parseFloat(parsedInfo.tokenAmount.uiAmountString || '0');
//           if (transferAmount > 0) {
//             if (isOwnerMatch(parsedInfo.destination)) {
//               type = 'buy';
//               totalAmount += transferAmount;
//             } else if (isOwnerMatch(parsedInfo.source)) {
//               type = 'sell';
//               totalAmount += transferAmount; // Aggregate, sign handled by balance
//             }
//           }
//         }
//       } else if ('data' in ix && ix.programId.toBase58() === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') {
//         // Attempt to decode Raydium instruction (simplified example)
//         try {
//           console.log('Raydium instruction data (manual decoding needed):', ix.data);
//           // Placeholder: Requires protocol-specific decoding logic
//           const estimatedAmount = 0; // Replace with actual decoding
//           if (estimatedAmount > 0) {
//             type = 'buy'; // Assume buy for now, refine with decoding
//             totalAmount += estimatedAmount;
//           }
//         } catch (error) {
//           console.log(`Failed to decode Raydium instruction: ${error}`);
//         }
//       }
//     }
//   }

//   // Process top-level instructions
//   for (const ix of instructions) {
//     if ('parsed' in ix && ix.parsed) {
//       const parsedInfo = ix.parsed.info;
//       console.log(`Parsed instruction for ${walletAddress}:`, parsedInfo);
//       if (parsedInfo && parsedInfo.tokenAmount && parsedInfo.mint === tokenAddress) {
//         const instructionAmount = parseFloat(parsedInfo.tokenAmount.uiAmountString || '0');
//         if (instructionAmount > 0) {
//           if (parsedInfo.type === 'transfer' && isOwnerMatch(parsedInfo.destination)) {
//             type = 'buy';
//             totalAmount += instructionAmount;
//           } else if (parsedInfo.type === 'transfer' && isOwnerMatch(parsedInfo.source)) {
//             type = 'sell';
//             totalAmount += instructionAmount;
//           }
//         }
//       }
//     } else if ('data' in ix) {
//       const program = ix.programId.toBase58();
//       console.log(`PartiallyDecodedInstruction for ${walletAddress}:`, ix.data);
//       if (program === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') {
//         try {
//           console.log('Raydium instruction data (manual decoding needed):', ix.data);
//         } catch (error) {
//           console.log(`Failed to decode Raydium instruction: ${error}`);
//         }
//       }
//     }
//   }

//   const timestamp = (tx.blockTime || 0) * 1000;

//   // Insert only meaningful transactions
//   if (type !== 'unknown' && totalAmount > 0) {
//     await db.run(
//       `INSERT INTO transactions (wallet_address, type, amount, protocol, timestamp)
//        VALUES (?, ?, ?, ?, ?)`,
//       [walletAddress, type, totalAmount, protocol, timestamp]
//     );
//     console.log(
//       `Recorded ${type} transaction for ${walletAddress}: ${totalAmount} tokens on ${protocol} (Signature: ${signature})`
//     );
//   } else {
//     console.log(
//       `Skipped transaction ${signature} for ${walletAddress}: Type=${type}, Amount=${totalAmount}`
//     );
//     console.log(`DEBUG SKIP: tx=${signature} for ${walletAddress}`);
//     console.log(JSON.stringify(tx, null, 2));
//   }
// }


// import {
//   Connection,
//   PublicKey,
//   ParsedTransactionWithMeta,
//   ParsedInstruction,
//   PartiallyDecodedInstruction,
// } from '@solana/web3.js';
// import {
//   getAssociatedTokenAddress,
//   TOKEN_PROGRAM_ID,
// } from '@solana/spl-token';
// import { openDB } from './db';
// import { RPC_URL, TOKEN_ADDRESS } from './config';
// import { sleep } from './utils';

// const connection = new Connection(RPC_URL, 'confirmed');

// export async function monitorTransactions() {
//   const db = await openDB();
//   const holders = await db.all(`SELECT address FROM holders ORDER BY balance DESC`);

//   console.log('Monitoring Transactions...');

//   for (const holder of holders) {
//     const pubKey = new PublicKey(holder.address);
//     let retries = 3;
//     while (retries > 0) {
//       try {
//         const signatures = await connection.getSignaturesForAddress(pubKey, { limit: 100 });
//         for (const sig of signatures) {
//           const tx = await connection.getParsedTransaction(sig.signature, {
//             maxSupportedTransactionVersion: 0,
//           });
//           if (tx) {
//             console.log(`Processing transaction ${sig.signature} for ${holder.address}`);
//             await processTransaction(tx, holder.address, sig.signature);
//           }
//           await sleep(200);
//         }
//         break;
//       } catch (error: any) {
//         if (error.message.includes('429')) {
//           console.log('Server responded with 429 Too Many Requests. Retrying after 500ms...');
//           await sleep(500);
//           retries--;
//         } else {
//           console.error(`Error processing transactions for ${holder.address}:`, error);
//           break;
//         }
//       }
//     }
//     await sleep(500);
//   }
// }

// async function processTransaction(
//   tx: ParsedTransactionWithMeta | null,
//   walletAddress: string,
//   signature: string
// ) {
//   if (!tx || !tx.meta) {
//     console.log(`Skipping transaction ${signature}: No transaction or meta data`);
//     return;
//   }

//   const db = await openDB();
//   let protocol = 'Unknown';
//   let type = 'unknown';
//   let amount = 0;

//   const instructions: (ParsedInstruction | PartiallyDecodedInstruction)[] =
//     tx.transaction.message.instructions;

//   for (const ix of instructions) {
//     if ('programId' in ix && ix.programId) {
//       const program = ix.programId.toBase58();
//       if (program === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') protocol = 'Jupiter';
//       if (program === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') protocol = 'Raydium';
//       if (program === '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP') protocol = 'Orca';
//     }
//   }

//   const tokenAddress = TOKEN_ADDRESS;
//   const walletPubKey = new PublicKey(walletAddress);

//   // Get associated token address for the wallet
//   const ata = await getAssociatedTokenAddress(new PublicKey(tokenAddress), walletPubKey);

//   const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubKey, {
//     programId: TOKEN_PROGRAM_ID,
//   });
//   const relevantTokenAccounts = tokenAccounts.value
//     .filter((acc) => acc.account.data.parsed.info.mint === tokenAddress)
//     .map((acc) => acc.pubkey.toBase58());

//   const isOwnerMatch = (owner: string) =>
//     owner === walletAddress || relevantTokenAccounts.includes(owner);

//   const preBalances = tx.meta.preTokenBalances || [];
//   const postBalances = tx.meta.postTokenBalances || [];
//   const innerInstructions = tx.meta.innerInstructions || [];

//   let preAmount = 0;
//   let postAmount = 0;

//   for (const postBalance of postBalances) {
//     if (postBalance.mint === tokenAddress && isOwnerMatch(postBalance.owner ?? '')) {
//       const preBalance = preBalances.find(
//         (pre) => pre.mint === tokenAddress && isOwnerMatch(pre.owner ?? '')
//       );
  
//       postAmount = parseFloat(postBalance.uiTokenAmount.uiAmountString ?? '0');
//       preAmount = preBalance
//         ? parseFloat(preBalance.uiTokenAmount.uiAmountString ?? '0')
//         : 0;
//     }
//   }

//   const amountChange = postAmount - preAmount;

//   if (amountChange > 0) {
//     type = 'buy';
//     amount = amountChange;
//   } else if (amountChange < 0) {
//     type = 'sell';
//     amount = -amountChange;
//   }

//   // Refine classification using innerInstructions
//   if (type === 'buy') {
//     const hasSwap = innerInstructions.some(ixGroup =>
//       ixGroup.instructions.some(ix =>
//         ('programId' in ix) &&
//         (ix.programId.toBase58() === 'SwaPpRgrLmT8vdPikP82Kkf8JVpGkJwhEEzx4ZqqFVL' ||
//          ix.programId.toBase58() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
//       )
//     );
//     if (!hasSwap) {
//       type = 'transfer_in';
//     }
//   } else if (type === 'sell') {
//     const hasSwap = innerInstructions.some(ixGroup =>
//       ixGroup.instructions.some(ix =>
//         ('programId' in ix) &&
//         (ix.programId.toBase58() === 'SwaPpRgrLmT8vdPikP82Kkf8JVpGkJwhEEzx4ZqqFVL' ||
//          ix.programId.toBase58() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
//       )
//     );
//     if (!hasSwap) {
//       type = 'transfer_out';
//     }
//   }

//   const timestamp = (tx.blockTime || 0) * 1000;

//   if (type !== 'unknown' && amount > 0) {
//     const tokenPrice = await fetchTokenPriceUSDT(tokenAddress);
  
//     await db.run(
//       `INSERT INTO transactions (wallet_address, type, amount, protocol, token_price_usdt, timestamp)
//        VALUES (?, ?, ?, ?, ?, ?)`,
//       [walletAddress, type, amount, protocol, tokenPrice ?? null, timestamp]
//     );
  
//     console.log(
//       `Recorded ${type} transaction for ${walletAddress}: ${amount} tokens on ${protocol} (Signature: ${signature})`
//     );
//   } else {
//     console.log(
//       `Skipped transaction ${signature} for ${walletAddress}: Type=${type}, Amount=${amount}`
//     );
//   }
  
// }

// // Fetch token price in USDT from Jupiter Aggregator
// async function fetchTokenPriceUSDT(tokenMint: string): Promise<number | null> {
//   try {
//     const response = await fetch(`https://price.jup.ag/v4/price?ids=${tokenMint}`);
//     const data = await response.json();
//     return data.data[tokenMint]?.price || null;
//   } catch (error) {
//     console.error('Failed to fetch token price:', error);
//     return null;
//   }
// }





