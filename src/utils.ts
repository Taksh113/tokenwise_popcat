// src/utils.ts

export function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  export function formatTimestamp(timestamp: number) {
    const date = new Date(timestamp * 1000);
    return date.toISOString();
  }
  
  export function logError(error: any, context: string = '') {
    console.error(`❌ Error${context ? ` in ${context}` : ''}:`, error.message || error);
  }
  