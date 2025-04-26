import sqlite3
import sys
from colorama import Fore, init

# Initialize colorama
init(autoreset=True)

def connect_db(db_path):
    try:
        conn = sqlite3.connect(db_path)
        print(f"Connected to {db_path}")
        return conn
    except sqlite3.Error as e:
        print(f"Error connecting to database: {e}")
        sys.exit(1)

def fetch_all_transactions(conn, query):
    # query = "SELECT * FROM transactions;"  # Ensure this matches your table name
    try:
        cursor = conn.cursor()
        cursor.execute(query)
        rows = cursor.fetchall()
        columns = [description[0] for description in cursor.description]
        if rows:
            print_table(columns, rows)
        else:
            print("No transactions found.")
    except sqlite3.Error as e:
        print(f"SQL error: {e}")

def print_table(columns, rows):
    # Calculate the column widths for formatting
    col_widths = [len(col) for col in columns]
    for row in rows:
        col_widths = [max(len(str(cell)), width) for cell, width in zip(row, col_widths)]

    # Print header
    header = " | ".join(col.ljust(width) for col, width in zip(columns, col_widths))
    print(header)
    print("-" * len(header))

    # Print rows with color
    for row in rows:
        transaction_type = str(row[3]).strip().lower()  # Strip spaces and lower case the transaction type
        # print("here" + transaction_type)
        # Apply color based on type
        if transaction_type == 'buy':
            color = Fore.GREEN
        elif transaction_type == 'sell':
            color = Fore.RED
        else:
            color = Fore.WHITE  # Default color for unexpected types

        # Apply color to each column in the row
        colored_row = [color + str(cell).ljust(width) for cell, width in zip(row, col_widths)]
        print(" | ".join(colored_row))

def main():
    db_path = "tokenwise.db"  # Path to your SQLite database file

    conn = connect_db(db_path)

    print("Displaying all transactions:")

    # Fetch and display all transactions
    query = input("Enter your query:\n")
    fetch_all_transactions(conn, query)

    conn.close()

if __name__ == "__main__":
    main()
