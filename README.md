# firehose-test-stack

Example integration using firehose to forward logs to Grafana Cloud


## Initial AWS account configuration

One-time account-level setup required before `cdk deploy FirehoseLogsStack`
(this is shared config: set it once per account, not per service. Every
service's copy of this stack reads the same SSM parameters and secret):

1. In Grafana Cloud, open [Observability -> Cloud provider -> AWS -> Configuration -> "Logs with Firehose"](https://pluralsight.grafana.net/a/grafana-csp-app/aws/configuration/cloudwatch-logs-firehose)
   Follow its wizard to create an access policy + token. It gives you an HTTP endpoint
   URL and a Loki instance ID.

2. Store the token in Secrets Manager:
     aws secretsmanager create-secret \
       --name /standard/grafana_cloud_firehose_logs \
       --secret-string '{"api_key":"<token from step 1>"}'

3. Store the endpoint URL and Loki instance ID in SSM Parameter Store:
     aws ssm put-parameter --type String \
       --name /standard/grafana_cloud_firehose_endpoint_url \
       --value https://<endpoint from step 1>
     aws ssm put-parameter --type String \
       --name /standard/grafana_cloud_firehose_loki_instance_id \
       --value <loki instance id from step 1>

The Loki instance ID identifies your tenant to Grafana Cloud's
multi-tenant Loki. Without it, deliveries fail with "401: no org id".

It's sent as the X-Scope-OrgID request header, Loki's standard
tenant-identification header:

https://grafana.com/docs/loki/latest/operations/multi-tenancy/

Both SSM parameters are read via dynamic references, resolved by
CloudFormation at deploy time, not by CDK at synth time. No env vars,
no AWS credentials needed at synth. If either parameter is missing or
misnamed, the failure surfaces as a CloudFormation deploy-time error,
not a synth-time one.

## Running this project

Find a log group in the account you are targeting to setup the Firehose subscription

```bash
npm install
AWS_PROFILE=<aws_profile> npx cdk bootstrap
AWS_PROFILE=<aws_profile> LOG_GROUP=<log_group> npx cdk deploy --require-approval never
```

## Useful commands

* `npm run build`   type-check the project
* `npm run watch`   watch for changes and type-check
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
