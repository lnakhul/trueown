-- NYC development seed. Independents (Tier 3) carry NULL parent_entity per the schema constraint.
INSERT INTO brands (id, name, corporate_tier, industry_vertical, parent_entity, unique_selling_proposition) VALUES
-- Corporate / VC backed (Tiers 1 & 2)
('b1111111-1111-1111-1111-111111111111', 'Blank Street Coffee', 2, 'coffee_bakery', 'Blank Street Inc.', 'Hyper-automated, venture-funded quick service coffee.'),
('b2222222-2222-2222-2222-222222222222', 'Maman', 2, 'coffee_bakery', 'Maman Group (PE Backed)', 'French-bistro style cafe specializing in nutty chocolate chip cookies.'),
('b3333333-3333-3333-3333-333333333333', 'Magnolia Bakery', 1, 'coffee_bakery', 'Turner Image Capital', 'World-famous iconic NYC bakery controlled by private equity.'),
-- True independents (Tier 3)
('b4444444-4444-4444-4444-444444444444', 'Coffee Project NY', 3, 'coffee_bakery', NULL, 'Award-winning local roaster and specialty coffee training lab.'),
('b5555555-5555-5555-5555-555555555555', 'Birch Coffee', 3, 'coffee_bakery', NULL, 'Long-standing independent Manhattan neighborhood favorite.'),
('b6666666-6666-6666-6666-666666666666', 'Porto Rico Importing Co.', 3, 'coffee_bakery', NULL, 'Historic family-owned coffee and tea merchant sourcing since 1907.'),
('b7777777-7777-7777-7777-777777777777', 'Mighty Oak Roasters', 3, 'coffee_bakery', NULL, 'Artisan wood-fired coffee roaster focusing on sustainability.');

INSERT INTO locations (id, brand_id, address, neighborhood, city, coordinates) VALUES
-- Blank Street
(gen_random_uuid(), 'b1111111-1111-1111-1111-111111111111', '186 W 4th St, New York, NY 10014', 'West Village', 'New York City', ST_SetSRID(ST_MakePoint(-74.0021, 40.7324), 4326)),
(gen_random_uuid(), 'b1111111-1111-1111-1111-111111111111', '980 Lexington Ave, New York, NY 10021', 'Upper East Side', 'New York City', ST_SetSRID(ST_MakePoint(-73.9612, 40.7698), 4326)),
-- Maman
(gen_random_uuid(), 'b2222222-2222-2222-2222-222222222222', '239 Centre St, New York, NY 10013', 'SoHo', 'New York City', ST_SetSRID(ST_MakePoint(-73.9996, 40.7225), 4326)),
(gen_random_uuid(), 'b2222222-2222-2222-2222-222222222222', '67 University Pl, New York, NY 10003', 'Greenwich Village', 'New York City', ST_SetSRID(ST_MakePoint(-73.9934, 40.7331), 4326)),
-- Magnolia Bakery
(gen_random_uuid(), 'b3333333-3333-3333-3333-333333333333', '401 Bleecker St, New York, NY 10014', 'West Village', 'New York City', ST_SetSRID(ST_MakePoint(-74.0048, 40.7359), 4326)),
-- Independents
(gen_random_uuid(), 'b4444444-4444-4444-4444-444444444444', '239 E 5th St, New York, NY 10003', 'East Village', 'New York City', ST_SetSRID(ST_MakePoint(-73.9897, 40.7271), 4326)),
(gen_random_uuid(), 'b5555555-5555-5555-5555-555555555555', '56 7th Ave, New York, NY 10011', 'Chelsea', 'New York City', ST_SetSRID(ST_MakePoint(-74.0003, 40.7391), 4326)),
(gen_random_uuid(), 'b6666666-6666-6666-6666-666666666666', '201 Bleecker St, New York, NY 10012', 'Greenwich Village', 'New York City', ST_SetSRID(ST_MakePoint(-74.0012, 40.7301), 4326)),
(gen_random_uuid(), 'b7777777-7777-7777-7777-777777777777', '28-01 24th Ave, Astoria, NY 11102', 'Astoria', 'New York City', ST_SetSRID(ST_MakePoint(-73.9242, 40.7744), 4326));
