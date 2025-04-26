# Tokenwise Program submission for NPC Task 2
TokenWise is a tool for monitoring and analyzing cryptocurrency wallet behavior, specifically focused on tracking specific tokens on the Solana blockchain. The system will identify the top holders of a specified token and monitor their transaction activities to provide insights into market movements.

## Setup Instructions of the repo locally

### 1. Install Dependencies

Run the following command to install all required dependencies:

```bash
npm install 
```
Make sure sqlite is installed by using
```bash
sqlite3 --version
```
If not use:
```bash
sudo apt install sqlite3
```


### 2. To use the codebase
```bash
npm run start
```

### 3. To use CLI tool
```bash
python3 cli.py
```
And then enter the SQL query which you want.

### Also put RPC_URL in .env file, you can use mainnet private RPC url from any platform such as Helius.