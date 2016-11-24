# dirpublish-monitor

Det er mulig å starte path-en fra src her: https://github.com/batfink/dirpublish-monitor/blob/master/src/pages/home/browser.json#L5 fordi roten er konfigurert her: https://github.com/batfink/dirpublish-monitor/blob/master/server.js#L3. Når vi setter en komponent som dependency og kun oppgir pathen til komponent-directoriet er det browser.json vi egentlig drar inn. Så denne _egentlige_ pathen i dette tilfellet er `"src/components/monitor/browser.json"` eller dersom vi heller ikke hadde brukt *app-module-path* så ville det vært `"../../components/monitor/browser.json"`.



