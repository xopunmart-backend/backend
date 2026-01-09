const http = require('http');

http.get('http://localhost:3000/api/categories', (resp) => {
    let data = '';

    resp.on('data', (chunk) => {
        data += chunk;
    });

    resp.on('end', () => {
        try {
            const categories = JSON.parse(data);
            if (categories.length > 0) {
                console.log(JSON.stringify(categories[0], null, 2));
            } else {
                console.log("No categories found");
            }
        } catch (e) {
            console.log("Error parsing: " + data);
        }
    });

}).on("error", (err) => {
    console.log("Error: " + err.message);
});
