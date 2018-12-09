module.exports = shipit => {
  // Load shipit-deploy tasks
  require("shipit-deploy")(shipit);

  shipit.initConfig({
    default: {
      deployTo: "/var/apps/tubebytes",
      repositoryUrl: "https://github.com/aakashlpin/tubebytes.git"
    },
    production: {
      servers: "root@167.99.73.64"
    }
  });

  shipit.task("start", async () => {
    await shipit.copyToRemote(
      "/Users/aakash/.aws/credentials",
      "/root/.aws/credentials"
    );
    await shipit.copyToRemote("/Users/aakash/.aws/config", "/root/.aws/config");
    await shipit.remote(
      "cd /var/apps/tubebytes/current/ && yarn && mkdir media && mkdir original && forever stopall && NODE_ENV=production forever start index.js"
    );
  });
};
