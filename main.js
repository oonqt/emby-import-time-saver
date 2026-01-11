import axios from 'axios';
import morgan from 'morgan';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import express from 'express';
import Logger from './logger.js';
import pkg from './package.json' with { type: 'json' };

const IS_DEV = process.env.NODE_ENV === 'development'

if (IS_DEV) {
    const dotenv = await import('dotenv');
    dotenv.config();
}

const {
    DEBUG,
    EMBY_URL,
    EMBY_API_KEY,
    DB_PATH,
    PORT,
    FORGET_DAYS
} = process.env;

const log = new Logger(pkg.name, process.env.DEBUG === 'true');
const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, { movies: {} });
const app = express();

const getMovieEntry = providerId => db.data.movies[providerId];

const setMovieEntry = async (providerId, value) => {
    db.data.movies[providerId] = value;
    await db.write();
}

const deleteMovieEntry = async providerId => {
    delete db.data.movies[providerId];
    await db.write();
}

app.use(express.json());
app.use(morgan(IS_DEV ? 'dev' : 'tiny', { 
    stream: { 
        write: msg => log.info(msg.trim()) 
    } 
}));

app.get('/ping', (_, res) => res.sendStatus(200));

app.post('/hook', async (req, res) => {
    const body = req.body;
    const event = body.Event;

    switch (event) {
        case '':
            break;
        default:
            log.warn(`Unhandled event type: ${event}`);
    }
    
    res.sendStatus(200);
});

log.info(`Starting ${pkg.name}_v${pkg.version}`);
app.listen(PORT, () => log.info(`Server listening on port ${PORT}`));
await db.read(); // init db