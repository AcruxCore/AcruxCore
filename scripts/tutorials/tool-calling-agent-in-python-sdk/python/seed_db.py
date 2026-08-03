import sqlite3

PRODUCTS = [
    # (id, name, category, price, stock)
    (1, "Aeron Chair", "Furniture", 1395.00, 12),
    (2, "Standing Desk", "Furniture", 640.00, 30),
    (3, "Mechanical Keyboard", "Electronics", 110.00, 220),
    (4, "4K Monitor", "Electronics", 480.00, 85),
    (5, "USB-C Hub", "Electronics", 45.00, 500),
    (6, "Desk Lamp", "Lighting", 65.00, 140),
    (7, "Noise-Cancelling Headphones", "Electronics", 320.00, 60),
    (8, "Ergonomic Mouse", "Electronics", 75.00, 300),
]

ORDERS = [
    # (id, product_id, quantity, order_date, customer)
    (1, 3, 4, "2026-05-02", "Acme Corp"), (2, 4, 2, "2026-05-05", "Globex"),
    (3, 1, 1, "2026-05-11", "Initech"), (4, 5, 20, "2026-05-14", "Acme Corp"),
    (5, 7, 3, "2026-05-19", "Umbrella"), (6, 3, 10, "2026-05-22", "Globex"),
    (7, 2, 5, "2026-06-01", "Initech"), (8, 4, 4, "2026-06-03", "Umbrella"),
    (9, 8, 12, "2026-06-08", "Acme Corp"), (10, 1, 2, "2026-06-12", "Globex"),
    (11, 7, 6, "2026-06-15", "Initech"), (12, 5, 40, "2026-06-18", "Umbrella"),
    (13, 6, 8, "2026-06-21", "Acme Corp"), (14, 3, 15, "2026-06-25", "Globex"),
    (15, 4, 1, "2026-06-29", "Initech"),
]


def seed(path: str = "store.db") -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        DROP TABLE IF EXISTS orders;
        DROP TABLE IF EXISTS products;
        CREATE TABLE products (
            id INTEGER PRIMARY KEY, name TEXT, category TEXT, price REAL, stock INTEGER
        );
        CREATE TABLE orders (
            id INTEGER PRIMARY KEY, product_id INTEGER REFERENCES products(id),
            quantity INTEGER, order_date TEXT, customer TEXT
        );
        """
    )
    conn.executemany("INSERT INTO products VALUES (?, ?, ?, ?, ?)", PRODUCTS)
    conn.executemany("INSERT INTO orders VALUES (?, ?, ?, ?, ?)", ORDERS)
    conn.commit()
    conn.close()
    print(f"Seeded {path}: {len(PRODUCTS)} products, {len(ORDERS)} orders.")


if __name__ == "__main__":
    seed()
