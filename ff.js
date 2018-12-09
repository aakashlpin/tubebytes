var ffmpeg = require("fluent-ffmpeg");

var firstFile = "title.mp4";
var secondFile = "source.mp4";
// var thirdFile = "third.mov";
var outPath = "out.mp4";

var proc = ffmpeg(firstFile)
  .input(secondFile)
  .input(thirdFile)
  //.input(fourthFile)
  //.input(...)
  .on("end", function() {
    console.log("files have been merged succesfully");
  })
  .on("error", function(err) {
    console.log("an error happened: " + err.message);
  })
  .mergeToFile(outPath);
