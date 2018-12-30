const fs = require("fs");
const urlParser = require("url");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const youtubedl = require("youtube-dl");
const ffmpeg = require("fluent-ffmpeg");
const AWS = require("aws-sdk");
const readline = require("readline");
const cors = require("cors");
const moment = require("moment");

const s3 = new AWS.S3();
const app = express();

app.use(bodyParser.urlencoded({ extended: false }));

// parse application/json
app.use(bodyParser.json());
app.use(cors());

const port = 3000;

app.get("/", (req, res) =>
  res.send(
    '<html><head><meta name="trafficjunky-site-verification" content="r65sxq62t" /></head><body>Hello World!</body></html>'
  )
);

app.post("/api/v1/slice", (req, res) => {
  const { url, slice_at, video_length } = req.body;
  /**
   * <t-xseconds of slice_at time, t+yseconds>
   */
  const userSelectedTime =
    slice_at.split(":").length === 2 ? `00:${slice_at}` : slice_at;

  const startAt = moment(userSelectedTime, "HH:mm:ss")
    .subtract(30, "seconds")
    .format("HH:mm:ss");

  const duration = "00:01:00";
  const { hostname } = urlParser.parse(url);

  youtubedl.getInfo(url, ["--format=best"], function(err, info) {
    if (err) throw err;

    const sliceVideoFilename = `${info.title.replace(
      /[^A-Z0-9]+/gi,
      "_"
    )}_${startAt}_${duration}.mp4`;

    const slicedVideoPath = path.resolve(
      __dirname,
      "media",
      sliceVideoFilename
    );

    ffmpeg(info.url)
      .inputOptions([`-ss ${startAt}`, `-t ${duration}`])
      .save(slicedVideoPath)
      .on("error", console.error)
      .on("progress", progress => {
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(`🔪Slicing... ${progress.timemark}`);
      })
      .on("end", () => {
        console.log("☁️Sending it in the clouds! Please wait...");

        s3.putObject(
          {
            Body: fs.createReadStream(slicedVideoPath),
            Bucket: "onehandapp-downloader",
            Key: `${hostname}/${sliceVideoFilename}`,
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
            console.log("🎉Sent!");
            fs.unlinkSync(slicedVideoPath);
            console.log("🗑Deleted local file");
          }
        );
      });
  });

  res.json("Hello World!");
});

app.listen(port, () => console.log(`Klipply ready on port ${port}!`));
