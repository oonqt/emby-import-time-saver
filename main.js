import axios from 'axios';
import morgan from 'morgan';
import express from 'express';
import ms from 'ms';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import Logger from './logger.js';
import pkg from './package.json' with { type: 'json' };

const IS_DEV = process.env.NODE_ENV === 'development'

if (IS_DEV) {
    const dotenv = await import('dotenv');
    dotenv.config();
}

const {
    DEBUG,
    PORT,
    EMBY_URL,
    EMBY_API_KEY,
    EMBY_LIBRARY_VIEW_USER,
    DB_PATH,
    SYNC_INTERVAL,
    FORGET_TIME,
    PERFORM_INITIAL_SYNC
} = process.env;

const log = new Logger(pkg.name, DEBUG?.toLowerCase() === 'true');
const app = express();
const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, { movies: {} });

app.use(express.json());
app.use(morgan(IS_DEV ? 'dev' : 'tiny', {
    stream: {
        write: msg => log.info(msg.trim())
    }
}));

const emby = axios.create({
    baseURL: `${EMBY_URL}/emby`,
    headers: {
        "X-Emby-Token": EMBY_API_KEY
    }
});

const getMovieEntry = providerId => db.data.movies[providerId];

const setMovieEntry = async (providerId, value) => {
    db.data.movies[providerId] = value;
    await db.write();
}

const deleteMovieEntry = async providerId => {
    delete db.data.movies[providerId];
    await db.write();
}

const getProviderFromItem = item => {
    const providers = item?.ProviderIds || {};
    
    if (providers.Tmdb) return `tmdb:${providers.Tmdb}`;
    if (providers.Tvdb) return `tvdb:${providers.Tvdb}`;
    if (providers.Imdb) return `imdb:${providers.Imdb}`;
    
    return null;
}

const handleMediaAdded = async (providerId, item) => {

}

const handleExistingMedia = async (providerId, item, entry) => {

}

const handleMediaRemove = async (providerId, entry) => {

}

const getMoviesPage = async (userId, startIndex, limit) => {
    const { data } = await emby(`/Users/${userId}/Items`, {
        params: {
            IncludeItemTypes: 'Movie,Episode',
            Recursive: true,
            Fields: 'DateCreated,ProviderIds',
            StartIndex: startIndex,
            Limit: limit
        }
    });

    return data;
}

const sync = async () => {
    try {
        log.info('Beginning sync with Emby server...');

        const now = new Date();
        const nowMs = now.getTime();
        
        const seen = new Set();

        let created = 0;
        let updated = 0;
        let missing = 0;
        let deleted = 0;

        const pageSize = 250;
        let startIndex = 0;

        while (true) {
            const page = await getMoviesPage(EMBY_LIBRARY_VIEW_USER, startIndex, pageSize);
            const items = page.Items;
            
            if (!items.length) break;

            for (const item of items) {
                const providerId = getProviderFromItem(item);
                const createdAt = item?.DateCreated;

                if (!providerId || !createdAt) {
                    log.debug(`Skipping item due to missing providerId:${providerId} or createdAt:${createdAt} -- (${item.Name})`);
                    continue;
                };

                log.debug(`Processing ${providerId} (${item.Name})`)

                seen.add(providerId);

                const entry = getMovieEntry(providerId);

                if (!entry) {
                    log.debug(`New media found ${providerId} (${item.Name})`);

                    await handleMediaAdded(providerId, item);
                    created++;
                    continue;
                }

                const recordedBaseline = entry.baseline;
                await handleExistingMedia(providerId, item, entry);
                const actualBaseline = getMovieEntry(providerId);
                
                if (actualBaseline !== recordedBaseline) {
                    log.debug(`Media updated date from ${recordedBaseline} to ${actualBaseline} -- ${providerId} (${item.Name})`);
                    updated++;
                }
            }

            startIndex += items.length;
            if (items.length < pageSize) break;
        }

        for (const [providerId, entry] of Object.entries(db.data.movies)) {
            if (seen.has(providerId)) continue; 

            await handleMediaRemove(providerId, entry);
            missing++;

            const lastSeenMs = Date.parse(entry.lastSeen);

            if (nowMs - lastSeenMs > ms(FORGET_TIME)) {
                log.debug(`Deleting ${providerId} from database due to being missing for longer than specified FORGET_TIME.`);
                await deleteMovieEntry(providerId);
                deleted++;
            }
        }

        log.info(`Finished syncing... Added ${created} database entries, Updated ${updated} entries, ${missing} missing entries, Deleted ${deleted} entries.`);
    } catch (err) {
        log.error('Failed to sync..', err);
    }
}

app.post('/hook', async (req, res) => {
    const body = req.body;
    const event = body.Event;
    const item = body.Item;

    log.info(item);

    switch (event) {
        case 'library.mediaadded':
            log.info('Received media added event...');
            break;
        case 'library.mediadeleted':
            log.info('Received media deleted event...');
            break;
        default:
            log.debug(`Unhandled event received: ${event}`);
            log.info(body);
    }

    res.sendStatus(200);
});

app.get('/ping', (__, res) => res.sendStatus(200));

log.info(`Starting ${pkg.name}_v${pkg.version}`);

// Initialize Webserver
app.listen(PORT, () => log.info(`Webserver listening on port ${PORT}`));

// Initialize Database
await db.read(); 

// Begin Syncing
if (PERFORM_INITIAL_SYNC?.toLowerCase() === 'true') sync();
setInterval(sync, ms(SYNC_INTERVAL));