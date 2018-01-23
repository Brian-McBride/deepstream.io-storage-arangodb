# deepstream.io-storage-arangodb [![npm version](https://badge.fury.io/js/deepstream.io-storage-arangodb.svg)](http://badge.fury.io/js/deepstream.io-storage-arangodb)

[![Greenkeeper badge](https://badges.greenkeeper.io/Brian-McBride/deepstream.io-storage-arangodb.svg)](https://greenkeeper.io/)

[deepstream](http://deepstream.io) storage connector for [arangodb](https://www.arangodb.com/)


##Basic Setup
```yaml
plugins:
  storage:
    name: arangodb
    options:
      username: 'deepstream_user'
      password: 'mySuperSecret'
      databaseURL: 'http://127.0.0.1:8529'
      databaseName: 'myDatabase'
      defaultCollection: 'someCollection'
      splitChar: '/'
```

```javascript
var Deepstream = require( 'deepstream.io' ),
    ArangoDBStorageConnector = require( 'deepstream.io-storage-arangodb' ),
    server = new Deepstream();

server.set( 'storage', new ArangoDBStorageConnector( {
  username: 'deepstream_user',
  password: 'mySuperSecret'
  connectionString: 'http://127.0.0.1:8529',
  splitChar: '/'
}));

server.start();
```