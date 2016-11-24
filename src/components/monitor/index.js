'use strict';

const defineComponent = require('marko-widgets').defineComponent;
const notis = require('src/components/notis');
const component = {};

component.template = require('./template.marko');

component.init = function() {

    let primus = new Primus('ws://localhost:7777/socket?query=string');
    let container = this.el;

    primus.write('Queued message from browser');

    primus.on('open', spark => {
        console.log('socket open');
        primus.write('Hello from browser!');
    });

    primus.on('error', error => {
        console.error('error received:', error);
    });

    primus.on('data', data => {
        const dataObj = JSON.parse(data);
        if (dataObj.hosts) {
            notis.render({
                publication: dataObj.hosts[0],
                event: dataObj.event,
                title: dataObj.data.document.title
            }).prependTo(container.firstChild);
        }
        console.log('data received:', dataObj);
    });

    primus.on('end', () => {
        console.log('connection closed');
    });

    this.el.addEventListener('click', function() {
        console.log('foo');
    });
};

module.exports = defineComponent(component);
