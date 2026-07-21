#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { FirehoseTestStack } from '../lib/firehose-test-stack';

const myLogGroup: string = process.env.LOG_GROUP ? process.env.LOG_GROUP : "undefined";

if (myLogGroup === "undefined") {
  throw new Error("LOG_GROUP env var not set");
}

const app = new cdk.App();
new FirehoseTestStack(app, 'FirehoseTestStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  logGroup: myLogGroup,
});
