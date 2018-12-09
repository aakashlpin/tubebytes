const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const mainOutput = path.resolve(__dirname, "media", "output.mp4");

ffmpeg("./myvideo.mp4")
  .inputOptions(["-ss 00:00:30", "-t 00:01:00"])
  .save(mainOutput)
  .on("error", console.error)
  .on("progress", progress => {
    process.stdout.cursorTo(0);
    process.stdout.clearLine(1);
    process.stdout.write(progress.timemark);
  })
  .on("end", () => {
    // fs.unlink(audioOutput, err => {
    // if (err) console.error(err);
    // else console.log("\nfinished downloading");
    // });
    console.log("\nfinished downloading");
  });
