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
      http = require('http'),
      EventEmitter = require('eventemitter3'),
      EE = new EventEmitter();

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

const sub = require('redis').createClient(),
      server = require('http').createServer(app),
      primus = new Primus(server, { transformer: 'websockets' });

primus.save('./src/thirdparty/primus.js');

bole.output({
    level: 'debug',
    stream: process.stdout
});

primus.on('connection', spark => {
    //log.debug('spark', spark);
    spark.write(JSON.stringify({'msg':'hello from server'}));
    EE.on('update', (data) => {
        //log.debug('update from redis received', JSON.parse(data));
        log.debug('data from redis received:', JSON.parse(data).type);
        spark.write(data);
    });
    spark.on('data', data => {
        log.debug('update from browser:', data);
    });
});

sub.on('message', (channel, message) => {
    EE.emit('update', message, sub);
});

sub.on('subscribe', (channel, count) => {
    log.debug(`Subscribed to redis channel ${channel} ${count}`)
});

sub.subscribe('direkte~dirpublish');

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
