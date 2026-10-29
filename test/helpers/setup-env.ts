import 'dotenv/config';

process.env.TEST_DATABASE_URL ??= 'postgres://trading:trading@localhost:55432/trading_test';
