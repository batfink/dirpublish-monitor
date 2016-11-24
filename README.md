# dirpublish-monitor

Det er mulig å starte path-en fra src her: https://github.com/batfink/dirpublish-monitor/blob/master/src/pages/home/browser.json#L5 fordi roten er konfigurert her: https://github.com/batfink/dirpublish-monitor/blob/master/server.js#L3. Når vi setter en komponent som dependency og kun oppgir pathen til komponent-directoriet er det browser.json vi egentlig drar inn. Så denne _egentlige_ pathen i dette tilfellet er `"src/components/monitor/browser.json"` eller dersom vi heller ikke hadde brukt *app-module-path* så ville det vært `"../../components/monitor/browser.json"`.

Hvis vi ser på browser.json i monitor-komponenten, så er det en linje med `require ./`: https://github.com/batfink/dirpublish-monitor/blob/master/src/components/monitor/browser.json#L3. To ting: Kolon etter require er valgfritt, og det vi faktisk peker til er filen index.js – så her kunne det også stått  `require ./index.js`. I noen eksempler brukes widget.js istedetfor index.js i komponenter som skal renderes i klienten – i så fall funker det ikke med bare `require ./`. 

På samme måte: Når w-bind brukes uten verdi, peker denne til index.js i samme dir. https://github.com/batfink/dirpublish-monitor/blob/master/src/components/monitor/template.marko#L1.

Den offiselle syntaxen for å strukturere en komponent er http://markojs.com/docs/marko-widgets/javascript-api/#definecomponentdef – men jeg synes det er litt mer oversiktlig med (men dette er smak og behag):

```js
const defineComponent = require('marko-widgets'),
      component = {};

component.template = require('./template.marko');

component.getTemplateData = function(state, input) {
    return {
        name: input.name
    };
};

component.handleClick = function() {
    this.el.style.backgroundColor = 'yellow';
}

module.exports = defineComponent(component);
```

