'use strict';

const defineComponent = require('marko-widgets').defineComponent;

const component = {};

component.template = require('./template.marko');

component.getInitialState = function(input) {
    return {
        publication: input.data.hosts[0].publication,
        event: input.data.event,
        title: input.data.data.document.title
    }
}

component.getTemplateData = function(state, input, out) {
    //console.log(input);
    return {
        publication: state.publication,
        event: state.event,
        title: state.title
    }
}

component.updateNote = function(note) {
    console.log('updateNote ny tittel:', note.data.document.title, ' - gammel tittel:', this.state.title);
    this.setState('title', note.data.document.title);
};

component.init = function() {
    console.log(`Notis med id ${this.id} er i DOM-en`);
};

component.onBeforeUpdate = function() {
    console.log(`Notis med id ${this.id} skal oppdateres`);
};

component.onUpdate = function() {
    console.log(`Notis med id ${this.id} er oppdatert`);
};

component.onDestroy = function() {
    console.log(`Notis med id ${this.id} er fjernet fra DOM-en`);
};

component.onRender = function(event) {
    console.log(`Notis med id ${this.id} er rendret. firstRender: ${event.firstRender}`);
};

module.exports = defineComponent(component);

