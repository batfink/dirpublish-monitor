'use strict';

require('app-module-path').addPath(__dirname);
require('marko/node-require').install();
require('marko/compiler').defaultOptions.writeToDisk = false;
require('marko/express');

const express = require('express'),
      path = require('path'),
      serveStatic = require('serve-static'),
      app = express(),
      bole = require('bole'),
      log = bole('server'),
      port = 7777,
      Primus = require('primus'),
      http = require('http');

app.use('/static', serveStatic(__dirname + '/static'));

require('lasso').configure({
    plugins: [ 'lasso-marko' ],
    outputDir: __dirname + '/static',
    fingerprintsEnabled: false,
    bundlingEnabled: true,
    urlPrefix: '/static',
    minify: false,
    bundles: [
        {
            name: "normalize.css",
            dependencies: [
                "require normalize.css"
            ]
        },
        {
            name: "marko-widgets",
            dependencies: [
                "require marko-widgets"
            ]
        }
    ]
});

const client = require('redis').createClient(),
      server = require('http').createServer(app),
      socket = new Primus(server, { transformer: 'websockets' });

socket.save('./src/thirdparty/primus.js');

bole.output({
    level: 'debug',
    stream: process.stdout
});

client.on('connect', () => {
    log.debug('connected to redis');
});

client.on('message', (channel, message) => {
    log.debug(`Message on channel ${channel}`, JSON.parse(message));
});

client.on('subscribe', (channel, count) => {
    log.debug(`Subscribed to redis pubsub channel ${channel} ${count}`)
});

client.subscribe('direkte~dirpublish');

app.get('/',
    (req, res, next) => {
        log.debug(req);
        next();
    },
    require('./src/pages/home')
);


server.listen(port, () => {
    log.info(`Listening on port ${port}`);
});
