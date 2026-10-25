INSERT INTO topics (slug, name, sort_order) VALUES ('aviation', 'Aviation', 1) ON CONFLICT(slug) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order;
INSERT INTO topics (slug, name, sort_order) VALUES ('electronics', 'Electronics', 2) ON CONFLICT(slug) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order;
INSERT INTO topics (slug, name, sort_order) VALUES ('jewelry', 'Jewelry', 3) ON CONFLICT(slug) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order;
INSERT INTO topics (slug, name, sort_order) VALUES ('furniture', 'Furniture', 4) ON CONFLICT(slug) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order;
INSERT INTO topics (slug, name, sort_order) VALUES ('knick-knacks', 'Knick-Knacks', 5) ON CONFLICT(slug) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order;
INSERT INTO topics (slug, name, sort_order) VALUES ('miscellaneous', 'Miscellaneous', 6) ON CONFLICT(slug) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order;
INSERT INTO topics (slug, name, sort_order) VALUES ('antiques', 'Antiques', 7) ON CONFLICT(slug) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order;
INSERT INTO topics (slug, name, sort_order) VALUES ('valuables', 'Valuables', 8) ON CONFLICT(slug) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order;
