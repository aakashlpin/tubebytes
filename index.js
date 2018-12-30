const fs = require("fs");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const youtubedl = require("youtube-dl");
const ffmpeg = require("fluent-ffmpeg");
const AWS = require("aws-sdk");
const readline = require("readline");
const cors = require("cors");

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
  console.log(req.body);
  const { url, slice_at, video_length } = req.body;
  // TODO: handle for when `video_length` is not enough to have a split_for of 1min.
  const formattedSliceAt =
    slice_at.split(":").length === 2 ? `00:${slice_at}` : slice_at;
  const slice_for = "00:01:00";
  const slidedVideoKey = url.split("viewkey=")[1];
  const sliceVideoFilename = `${slidedVideoKey}_${formattedSliceAt}_${slice_for}.mp4`;
  const slicedVideo = path.resolve(__dirname, "media", sliceVideoFilename);

  youtubedl.getInfo(url, ["--format=best"], function(err, info) {
    if (err) throw err;
    ffmpeg(info.url)
      .inputOptions([`-ss ${formattedSliceAt}`, `-t ${slice_for}`])
      .save(slicedVideo)
      .on("error", console.error)
      .on("progress", progress => {
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(`slicing.... ${progress.timemark}`);
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

  res.json("Hello World!");
});

app.listen(port, () => console.log(`Tubebyt.es app ready on port ${port}!`));
