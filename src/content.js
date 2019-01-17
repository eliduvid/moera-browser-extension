var actualCode = '(' + function() {
    fetch("%URL%")
        .then(response => response.text())
        .then(text => {
            var content = text.replace(
                /<head>/i,
                "<head><base href='%URL%'>");
            document.open("text/html", "replace");
            document.write(content);
            document.close();
        });
} + ')();';
browser.storage.local.get()
    .then(settings => {
        if (settings.clientUrl) {
            actualCode = actualCode.replace(/%URL%/g, settings.clientUrl);
            console.log(actualCode);
            var script = document.createElement('script');
            script.textContent = actualCode;
            (document.head||document.documentElement).appendChild(script);
        }
    });
