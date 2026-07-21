import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as destinations from 'aws-cdk-lib/aws-logs-destinations';

const stage: string = process.env.STAGE ? process.env.STAGE : "sandbox";

export interface FirehoseTestStackStackProps extends cdk.StackProps {
  logGroup: string;
}

export class FirehoseTestStack extends cdk.Stack {
  public readonly backupBucket: s3.Bucket;
  public readonly grafanaSecret: secretsmanager.ISecret;
  public readonly deliveryStream: firehose.CfnDeliveryStream;

  constructor(scope: Construct, id: string, props: FirehoseTestStackStackProps) {
    super(scope, id, props);

    const grafanaFirehoseEndpointUrl = ssm.StringParameter.valueForStringParameter(
      this,
      '/standard/grafana_cloud_firehose_endpoint_url'
    );
    const grafanaLokiInstanceId = ssm.StringParameter.valueForStringParameter(
      this,
      '/standard/grafana_cloud_firehose_loki_instance_id'
    );

    const logGroup = logs.LogGroup.fromLogGroupName(this, `logGroupImport`, props.logGroup);

    this.backupBucket = new s3.Bucket(this, 'FirehoseFailedDeliveryBackup', {
      bucketName: `firehose-test-delivery-firehose-backup-${stage}-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(14) }],
    });

    // The access-key token is created manually via Grafana Cloud's "Logs
    // with Firehose" setup wizard, then stored here as:
    //   { "api_key": "<token>" }
    // This exact JSON key name ("api_key", not "accessKey") is required by
    // AWS Firehose's Secrets Manager integration for HTTP-endpoint
    // destinations — see:
    // https://docs.aws.amazon.com/firehose/latest/dev/secrets-manager-whats-secret.html
    this.grafanaSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GrafanaFirehoseSecret',
      '/standard/grafana_cloud_firehose_logs'
    );

    const firehoseRole = new iam.Role(this, 'FirehoseDeliveryRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });
    this.backupBucket.grantReadWrite(firehoseRole);
    this.grafanaSecret.grantRead(firehoseRole);

    const deliveryErrorLogGroup = new logs.LogGroup(this, 'FirehoseDeliveryErrorLogGroup', {
      logGroupName: `/aws/kinesisfirehose/firehose-test-delivery-logs-${stage}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    deliveryErrorLogGroup.grantWrite(firehoseRole);

    // Firehose doesn't auto-create the log stream inside the log group for
    // this delivery path -- without this, delivery error logging fails with
    // "The specified log stream does not exist."
    new logs.LogStream(this, 'FirehoseDeliveryErrorLogStream', {
      logGroup: deliveryErrorLogGroup,
      logStreamName: 'DestinationDelivery',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.deliveryStream = new firehose.CfnDeliveryStream(this, 'GrafanaLogsDeliveryStream', {
      deliveryStreamName: `firehose-test-delivery-logs-${stage}`,
      deliveryStreamType: 'DirectPut',
      httpEndpointDestinationConfiguration: {
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: deliveryErrorLogGroup.logGroupName,
          logStreamName: 'DestinationDelivery',
        },
        endpointConfiguration: {
          url: grafanaFirehoseEndpointUrl,
          name: 'GrafanaCloudLoki',
          // Using the older access key mechanism, was unable to get the secret
          // to resolve correctly
          accessKey: this.grafanaSecret.secretValueFromJson('api_key').unsafeUnwrap(),
        },
        requestConfiguration: {
          contentEncoding: 'GZIP',
          commonAttributes: [
            { attributeName: 'X-Scope-OrgID', attributeValue: grafanaLokiInstanceId },
          ],
        },
        roleArn: firehoseRole.roleArn,
        s3BackupMode: 'FailedDataOnly',
        s3Configuration: {
          bucketArn: this.backupBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
        },
        // No processingConfiguration here: Grafana Cloud's Firehose receiver
        // (loki.source.awsfirehose) decodes CloudWatch Logs subscription-filter
        // records itself; gzip decompress + JSON parse + per-event extraction
        // So it wants the raw record Firehose gets from the subscription
        // filter. AWS's built-in Decompression processor isn't available for
        // HTTP endpoint destinations anyway, and CloudWatchLogProcessing can't
        // be enabled without it.
        // see: https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.awsfirehose/
        retryOptions: {
          durationInSeconds: 300,
        },
      },
    });

    // The delivery stream only references the role's ARN (Fn::GetAtt), so
    // CloudFormation's implicit dependency graph won't wait for the role's
    // default policy (the resource that actually grants s3:PutObject /
    // secretsmanager:GetSecretValue) to exist before creating the delivery
    // stream. Without this, a fresh deploy can hit intermittent
    // access-denied errors while Firehose validates destination access.
    this.deliveryStream.node.addDependency(firehoseRole);

    const importedDeliveryStream = firehose.DeliveryStream.fromDeliveryStreamArn(
      this,
      'ImportedDeliveryStream',
      this.deliveryStream.attrArn
    );

    new logs.SubscriptionFilter(this, 'AppLogSubscription', {
      logGroup: logGroup,
      destination: new destinations.FirehoseDestination(importedDeliveryStream),
      filterPattern: logs.FilterPattern.allEvents(),
    });
  }
}
