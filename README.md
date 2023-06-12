# website-monitor
 
This app is for my personal use.

url: the link to be crawled*

outputDir: the folder to save to*



waitLoad: which criterion to use to wait for the page to finish loading

    - "domcontentloaded" means wait for the entire HTML file to be parsed, but external resources such as images are not yet loaded (the most aggressive option, can't crawl any JS content)

    - "loaded" means to wait for all the resources in the HTML file (images, etc.) to be loaded, but this does not necessarily include the JS dynamically loaded content. This is the default value

    - "networkidle2" means wait for 500ms without more than two network requests. All network activity is included

    - "networkidle0" means wait 500ms for no new network requests (the most conservative option, not recommended)

waitTimeout: wait for a fixed amount of time in seconds on top of waitLoad

waitSelector: waits for the appearance of an element in addition to the previous two wait options, in the form of a CSS selector. For example, "#title" means wait until an element with the id title appears before continuing

timeout: the timeout for each of the above, in seconds, default 15



preprocess(): This function is executed on the page after all the waits are over. It can be used to remove elements that are not needed

textToCompare(): Get the content used to compare page changes. This function must return a string. It is only used for comparison, it does not save

resourcesToCompare(): Gets the content used to compare the page's resource changes. Returns an array of strings, and if it contains an element that does not match the previous one, the resources corresponding to that element will be saved

extract(): Gets the content of the page. This function must return a string

extractResource(id): Download the specified resource. Pass in a string from resourcesToCompare(). Specify fetchResource to download the URL directly.



interval: interval time. Either specify a number of seconds, such as 5, or specify a random range(5, 10)