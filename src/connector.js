const events = require( 'events' );
const util = require( 'util' );
const pckg = require( '../package.json' );
const arangojs = require('arangojs');
const aql = require('arangojs').aql;
const dataTransform = require( './transform-data' );

/**
 * Connects deepstream to ArangoDB.
 *
 * Collections, ids and performance
 * --------------------------------------------------
 * Deepstream treats its storage like a simple key value store. But there are a few things
 * we can do to speed it up when using ArangoDB. Mainly: using smaller (e.g. more granular) collections and using successive Id's
 *
 *
 * To support multiple collections pass a splitChar setting to this class. This setting specifies a character
 * at which keys will be split and ordered into collections. This sounds a bit complicated, but all that means is the following:
 *
 * Imagine you want to store a few users. Just specify their recordNames as e.g.
 *
 *  user/i4vcg5j1-16n1qrnziuog
 *  user/i4vcg5x9-a2wc3g9pbhmi
 *  user/i4vcg74u-21ufhl1qs8fh
 *
 * and in your options set
 *
 * { splitChar: '/' }
 *
 * This way the ArangoDB connector will create a 'user' collection the first time
 * it encounters this recordName and will subsequently store users in it. This will
 * improve the speed of read operations since ArangoDB has to look through a smaller
 * amount of datasets to find your record
 *
 * On top of this, it makes sense to use successive ids. ArangoDB will optimise collections
 * by putting documents with similar ids next to each other. Fortunately, the build-in getUid()
 * method of the deepstream client already produces semi-succesive ids. Notice how the first bits of the
 * ids (user/i4vcg5) are all the same. These are Base36 encoded timestamps, facilitating almost succesive ordering.
 *
 * @param {Object} options
 *
   {
    // Optional: Database url path. Defaults to 'http://127.0.0.1:8529'
    databaseURL: <String>,
    // Optional: Database to store all collections into. Defaults to 'deepstream'
    databaseName: <String>,
    // Optional: Database username for basic auth. Defaults to 'deepstream'
    username: <String>,
    // Optional: Database password for basic auth. Defaults to 'deepstream'
    password: <String>,
    // Optional: Collections for items without a splitChar or if no splitChar is specified. Defaults to 'deepstream_docs'
    defaultCollection: <String>,
    // Optional: A char that seperates the collection name from the document id. Defaults to null
    splitChar: <String>
   }
 *
 * @constructor
 */
class Connector {
    constructor(options) {
        this.isReady = false;
        this.name = pckg.name;
        this.version = pckg.version;
        this._dbUrl = options.databaseURL || 'http://127.0.0.1:8529';
        this._databaseName = options.databaseName || 'deepstream';
        this._databaseUser = options.username || 'deepstream';
        this._databasePass = options.password || 'deepstream';
        this._splitChar = options.splitChar || null;
        this._defaultCollection = options.defaultCollection || 'deepstream_docs';
        this._db = null;
        this._collections = {};

        this._db = arangojs(this._dbUrl);

        this._db.useBasicAuth(this._databaseUser, this._databasePass);

        this._db.listUserDatabases()
            .then(names => {
                return new Promise((resolve, reject) => {
                    let found = false;
                    names.forEach(name => {
                        if (name === this._databaseName) {
                            found = true;
                            resolve(name);
                        }
                    });

                    if (!found) {
                        this._db.createDatabase(this._databaseName, [{ username: this._databaseUser, passwd: this._databasePass }])
                            .then(resolve)
                            .catch(reject)
                    }
                });
            })
            .then((foundName) => {
                return this._db.useDatabase(this._databaseName)
            })
            .then(success => {
                this.isReady = true;
                this.emit( 'ready' );
            })
            .catch(err => {
                this.emit( 'error', err )
            });
    }

    /**
     * Writes a value to the storage.
     *
     * @param {String}   key
     * @param {Object}   value
     * @param {Function} callback Should be called with null for successful set operations or with an error message string
     *
     * @private
     * @returns {void}
     */
    set(key, value, callback) {
        const params = this._getParams( key );

        if( params === null ) {
            callback( `Invalid key ${key}` );
            return
        }

        value = dataTransform.transformValueForStorage( value );
        value._key = params.id;

        this._db.query(aql`
                UPSERT { _key: ${value._key} } 
                INSERT ${value} 
                REPLACE ${value} 
                IN ${params.collection}`,
            (err, res) => {
                if (err) return callback(err, res);
                callback(null, true);
            })
    }

    /**
     * Retrieves a value from the storage
     *
     * @param {String}   key
     * @param {Function} callback Will be called with null and the stored object
     *                            for successful operations or with an error message string
     *
     * @private
     * @returns {void}
     */
    get(key, callback) {
        const params = this._getParams(key);

        if (params === null) {
            callback(`Invalid key ${key}`);
            return
        }

        this._db.query(aql`
                FOR r IN ${params.collection}
                FILTER r._key == ${key}
                LIMIT 1
                RETURN r`,
            (err, cursor) => {
                if (err) return callback(err, null);
                cursor.next((err, record) => {
                    if (err || !record) return callback(null, null);
                    let doc = dataTransform.transformValueFromStorage(record)
                    callback(null, doc);
                })
            })
    }

    /**
     * Deletes an entry from the cache.
     *
     * @param   {String}   key
     * @param   {Function} callback Will be called with null for successful deletions or with
     *                     an error message string
     *
     * @private
     * @returns {void}
     */
    delete(key, callback) {
        const params = this._getParams( key );

        if( params === null ) {
            callback( `Invalid key ${key}` );
            return
        }

        this._db.query(aql`
                REMOVE ${key} IN ${params.collection}`,
            (err, res) => {
                if (err) return callback(err, null);
                callback(null, true);
            })
    }

    /**
     * Determines the document id and the collection
     * to use based on the provided key
     *
     * Creates the collection if it doesn't exist yet.
     *
     * @param {String} key
     *
     * @private
     * @returns {Object} {connection: <MongoConnection>, id: <String> }
     */
    _getParams(key) {
        const index = key.indexOf( this._splitChar );
        let collectionName;
        let id;

        if( index === 0 ) {
            return null // cannot have an empty collection name
        } else if( index === -1 ) {
            collectionName = this._defaultCollection;
            id = key
        } else {
            collectionName = key.substring(0, index);
            id = key.substring(index + 1);
        }

        return { collection: this._getCollection( collectionName ), id }
    }

    /**
     * Returns a MongoConnection object given its name.
     * Creates the collection if it doesn't exist yet.
     *
     * @param {String} collectionName
     *
     * @private
     * @returns {Object} <MongoConnection>
     */
    _getCollection(collectionName) {
        if( !this._collections[ collectionName ] ) {
            this._collections[ collectionName ] = this._db.collection( collectionName );
            // Ensure collection exists:
            this._collections[ collectionName ].get((err, res) => {
                if (err) {
                    this._collections[ collectionName ].create({
                        name: collectionName,
                        keyOptions: {
                            allowUserKeys: true
                        }
                    }, (err, res) => {
                        if (err) {console.error(err)}; // Serious error here :(
                    })
                }
            })
        }

        // TODO This could cause a write error on first write... collection could not be ready (async create above)
        return this._collections[ collectionName ]
    }
}

util.inherits( Connector, events.EventEmitter );

module.exports = Connector;