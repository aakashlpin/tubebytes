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
  res.send("<html><head></head><body>Hello World!</body></html>")
);

app.get("/api/v1/slices", (req, res) => {
  res.json({
    videos: [
      "https://s3.amazonaws.com/onehandapp-downloader/www.youtube.com/Anderson_Paak_The_Free_Nationals_NPR_Music_Tiny_Desk_Concert_00%3A03%3A31_00%3A01%3A00.mp4",
      "https://s3.amazonaws.com/onehandapp-downloader/www.youtube.com/Australia_vs_India_3rd_Test_Match_Story_00%3A00%3A05_00%3A01%3A00.mp4",
      "https://s3.amazonaws.com/onehandapp-downloader/www.youtube.com/Estas_Tonne_The_Song_of_the_Golden_Dragon_00%3A03%3A36_00%3A01%3A00.mp4",
      "https://s3.amazonaws.com/onehandapp-downloader/www.youtube.com/Fkj_Live_at_La_F_e_Electricit_Paris_00%3A08%3A26_00%3A01%3A00.mp4",
      "https://s3.amazonaws.com/onehandapp-downloader/www.youtube.com/Friends_the_Test_Part_1_Challenge_00%3A01%3A09_00%3A01%3A00.mp4",
      "https://s3.amazonaws.com/onehandapp-downloader/www.youtube.com/MB14_vs_SARO_Grand_Beatbox_LOOPSTATION_Battle_2017_SEMI_FINAL_00%3A07%3A16_00%3A01%3A00.mp4",
      "https://s3.amazonaws.com/onehandapp-downloader/www.youtube.com/OCEAN_John_Butler_2012_Studio_Version_00%3A03%3A53_00%3A01%3A00.mp4",
      "https://s3.amazonaws.com/onehandapp-downloader/www.youtube.com/Post_Malone_Swae_Lee_Sunflower_Spider_Man_Into_the_Spider_Verse__00%3A00%3A17_00%3A01%3A00.mp4",
      "https://s3.amazonaws.com/onehandapp-downloader/www.youtube.com/TOP_10_INSANE_REVENGE_MOMENTS_IN_CRICKET_HISTORY_2018_00%3A01%3A20_00%3A01%3A00.mp4",
      "https://s3.amazonaws.com/onehandapp-downloader/www.youtube.com/The_Black_Keys_Tighten_Up_Electric_Blues_Rock_Guitar_Lesson_Tutorial_How_to_Play_Fender_Tele_00%3A02%3A08_00%3A01%3A00.mp4",
      "https://s3.amazonaws.com/onehandapp-downloader/www.youtube.com/The_Roots_feat_Bilal_NPR_Music_Tiny_Desk_Concert_00%3A02%3A05_00%3A01%3A00.mp4",
      "https://s3.amazonaws.com/onehandapp-downloader/www.youtube.com/benny_blanco_Halsey_Khalid_Eastside_official_video__00%3A00%3A29_00%3A01%3A00.mp4"
    ]
  });
});

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
        process.stdout.write(`🔪\rSlicing! Please wait...`);
      })
      .on("end", () => {
        console.log("☁️\rSending it in the clouds! Please wait...");

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
            console.log("🎉\rSent!");
            fs.unlinkSync(slicedVideoPath);
            console.log("🗑\rDeleted local file");
          }
        );
      });
  });

  res.json("Hello World!");
});

app.listen(port, () => console.log(`Klipply ready on port ${port}!`));
