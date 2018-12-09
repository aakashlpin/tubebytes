const fs = require("fs");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const youtubedl = require("youtube-dl");
const ffmpeg = require("fluent-ffmpeg");
const AWS = require("aws-sdk");
const readline = require("readline");

const s3 = new AWS.S3();
const app = express();

app.use(bodyParser.urlencoded({ extended: false }));

// parse application/json
app.use(bodyParser.json());

const port = 80;

app.get("/", (req, res) => res.send("Hello World!"));

app.post("/api/v1/slice", (req, res) => {
  console.log(req.body);
  const { url, slice_at, video_length } = req.body;
  // TODO: handle for when `video_length` is not enough to have a split_for of 1min.
  const formattedSliceAt =
    slice_at.split(":").length === 1 ? `00:${slice_at}` : slice_at;
  const slice_for = "00:01:00";
  const slidedVideoKey = url.split("viewkey=")[1];
  const sliceVideoFilename = `${slidedVideoKey}_${formattedSliceAt}_${slice_for}.mp4`;
  const slicedVideo = path.resolve(__dirname, "media", sliceVideoFilename);
  const downloadedVideo = path.resolve(
    __dirname,
    "original",
    `${slidedVideoKey}.mp4`
  );

  let downloaded = 0;
  if (fs.existsSync(downloadedVideo)) {
    downloaded = fs.statSync(downloadedVideo).size;
  }

  const video = youtubedl(url, ["--format=best"]);

  let videoSize;
  video.on("info", function(info) {
    console.log("Download started");
    console.log("filename: " + info._filename);

    // info.size will be the amount to download, add
    videoSize = info.size + downloaded;
    console.log("size: " + videoSize);

    if (downloaded > 0) {
      // size will be the amount already downloaded
      console.log("resuming from: " + downloaded);

      // display the remaining bytes to download
      console.log("remaining bytes: " + info.size);
    }
  });

  video.pipe(fs.createWriteStream(downloadedVideo, { flags: "a" }));

  // Will be called if download was already completed and there is nothing more to download.
  video.on("complete", function complete(info) {
    "use strict";
    console.log("filename: " + info._filename + " already downloaded.");
  });

  let amount = 0;
  video.on("data", function data(chunk) {
    amount += chunk.length;
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(
      `downloading.... ${parseInt(
        (1 - (videoSize - amount) / videoSize) * 100,
        10
      )}%`
    );
  });

  video.on("end", function() {
    console.log(
      `>>>> Finished downloading! Now slicing it up from ${formattedSliceAt} <<<<`
    );

    ffmpeg(downloadedVideo)
      .inputOptions([`-ss ${formattedSliceAt}`, `-t ${slice_for}`])
      .save(slicedVideo)
      .on("error", console.error)
      .on("progress", progress => {
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(`slicing....${progress.timemark}`);
      })
      .on("end", () => {
        console.log(">>>> Finished slicing! Now uploading to S3 <<<<");

        const s3Bucket = "onehandapp-downloader";

        s3.putObject(
          {
            Body: fs.createReadStream(slicedVideo),
            Bucket: s3Bucket,
            Key: sliceVideoFilename,
            ContentDisposition: `inline; filename="${sliceVideoFilename.replace(
              '"',
              "'"
            )}"`,
            ContentType: "video/mp4"
          },
          error => {
            if (error) {
              revoke(error);
            }
            console.log("Uploaded to S3!");
          }
        );
      });
  });

  res.send("Hello World!");
});

app.listen(port, () => console.log(`Tubebyt.es app ready on port ${port}!`));
