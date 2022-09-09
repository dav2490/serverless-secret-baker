"use strict";

const BbPromise = require("bluebird");
const fs = require("fs");
const defaultSecretsFile = "secret-baker-secrets.json";
const optionsParamsRegex = /(?<key>[^=]+)=(?<value>.+)/;

BbPromise.promisifyAll(fs);

class ServerlessSecretBaker {
  constructor(serverless, options = {}) {
    const pkgHooks = {
      "before:package:createDeploymentArtifacts": this.packageSecrets.bind(
        this
      ),
      "before:deploy:function:packageFunction": this.packageSecrets.bind(this),
      // For serverless-offline plugin
      "before:offline:start": this.packageSecrets.bind(this),
      // For invoke local
      "before:invoke:local:invoke": this.packageSecrets.bind(this),
    };

    const cleanupHooks = {
      "after:package:createDeploymentArtifacts": this.cleanupPackageSecrets.bind(
        this
      ),
      "after:deploy:function:packageFunction": this.cleanupPackageSecrets.bind(
        this
      ),
      // For serverless-offline plugin
      "before:offline:start:end": this.cleanupPackageSecrets.bind(this),
      // For invoke local
      "after:invoke:local:invoke": this.cleanupPackageSecrets.bind(this),
    };

    const params = this.readParams(options.param || []);
    const shouldCleanup = !params["secret-baker-cleanup"];

    this.hooks = shouldCleanup ? { ...pkgHooks, ...cleanupHooks } : pkgHooks;
    this.options = options;
    this.serverless = serverless;
    this.secretsFile = defaultSecretsFile;
  }

  readParams(params) {
    const resultParams = {};
    for (const item of params) {
      for (const splitted of item.split(",")) {
        const res = splitted.match(optionsParamsRegex);
        resultParams[res.groups.key] = {
          value: res.groups.value.trimEnd(),
          type: "cli",
        };
      }
    }
    return resultParams;
  }

  getSecretsConfig() {
      const secrets = (this.serverless.service.custom && this.serverless.service.custom.secretBaker && custom.secretBaker.secrets) || [];
      const customSecretsFile = (this.serverless.service.custom && this.serverless.service.custom.secretBaker && custom.secretBaker.filePath) || undefined;
      this.secretsFile = customSecretsFile ? customSecretsFile : this.secretsFile;
      
      if (Array.isArray(secrets)) {
          return secrets.map((item) => {
              if (typeof item === 'string') {
                  return {
                      name: item,
                      path: item
                  }
              } else {
                  return item
              }
          })
      } else if (typeof secrets === 'object') {
          return Object.entries(secrets).map(([name, path]) => ({
              name,
              path
          }));
      }
      throw new this.serverless.classes.Error(
          "Secret Baker configuration contained an unexpected value."
      );
  }

  async writeSecretToFile() {
    const providerSecrets = this.getSecretsConfig();
    const secrets = {};


    for (const {name, path} of providerSecrets) {
      const param = await this.getParameterFromSsm(path);

      if (!param) {
        throw Error(`Unable to load Secret ${name}`);
      }

      secrets[name] = {
        ciphertext: param.Value,
        arn: param.ARN
      };
    }

    return fs.writeFileAsync(this.secretsFile, JSON.stringify(secrets));
  }

  getParameterFromSsm(name) {
    return this.serverless
      .getProvider("aws")
      .request(
        "SSM",
        "getParameter",
        {
          Name: name,
          WithDecryption: false
        },
        { useCache: true }
      ) // Use request cache
      .then(response => BbPromise.resolve(response.Parameter))
      .catch(err => {
        if (err.statusCode !== 400) {
          return BbPromise.reject(
            new this.serverless.classes.Error(err.message)
          );
        }

        return BbPromise.resolve(undefined);
      });
  }

  cleanupPackageSecrets() {
    this.serverless.cli.log(`Cleaning up ${this.secretsFile}`);
    if (fs.existsSync(this.secretsFile)) fs.unlinkSync(this.secretsFile);
  }

  packageSecrets() {
    this.serverless.cli.log("Serverless Secrets beginning packaging process");
    this.serverless.service.package.include =
      this.serverless.service.package.include || [];
    return this.writeSecretToFile().then(() =>
      this.serverless.service.package.include.push(this.secretsFile)
    );
  }
}

module.exports = ServerlessSecretBaker;
