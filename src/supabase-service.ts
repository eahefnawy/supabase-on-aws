import * as cdk from 'aws-cdk-lib';
import * as appmesh from 'aws-cdk-lib/aws-appmesh';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { SupabaseDatabase } from './supabase-db';

const envoyCpuRate = 0.4;
const envoyMemRate = 0.1;
const otelCpuRate = 0.1;
const otelMemRate = 0.1;
const appCpuRate = 1.0 - envoyCpuRate - otelCpuRate;
const appMemRate = 1.0 - envoyMemRate - otelMemRate;

export class SupabaseServiceBase extends Construct {
  virtualService?: appmesh.VirtualService;
  virtualNode?: appmesh.VirtualNode;

  constructor(scope: Construct, id: string) {
    super(scope, id);
  }
}

export interface SupabaseServiceProps {
  cluster: ecs.ICluster;
  containerDefinition: ecs.ContainerDefinitionOptions;
  cpu?: number;
  memory?: number;
  cpuArchitecture?: ecs.CpuArchitecture;
  autoScalingEnabled?: boolean;
  mesh?: appmesh.Mesh;
}

export class SupabaseService extends SupabaseServiceBase {
  listenerPort: number;
  ecsService: ecs.FargateService;
  cloudMapService: servicediscovery.Service;
  logGroup: logs.LogGroup;
  forceDeployFunction: targets.LambdaFunction;

  constructor(scope: Construct, id: string, props: SupabaseServiceProps) {
    super(scope, id);

    const serviceName = id.toLowerCase();
    const { cluster, containerDefinition, mesh } = props;
    const cpu = props.cpu || 1024;
    const memory = props.memory || 2048;
    const cpuArchitecture = props.cpuArchitecture || ecs.CpuArchitecture.ARM64;
    const autoScalingEnabled = (typeof props.autoScalingEnabled == 'undefined') ? true : props.autoScalingEnabled;
    const meshEnabled = typeof props.mesh != 'undefined';

    this.listenerPort = containerDefinition.portMappings![0].containerPort;

    const proxyConfiguration = new ecs.AppMeshProxyConfiguration({
      containerName: 'envoy',
      properties: {
        ignoredUID: 1337,
        ignoredGID: 1338,
        appPorts: [this.listenerPort],
        proxyIngressPort: 15000,
        proxyEgressPort: 15001,
        //egressIgnoredPorts: [2049], // EFS
        egressIgnoredIPs: ['169.254.170.2', '169.254.169.254'],
      },
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu,
      memoryLimitMiB: memory,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture,
      },
      proxyConfiguration: (meshEnabled) ? proxyConfiguration : undefined,
    });

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_MONTH,
    });

    const logging = new ecs.AwsLogDriver({ logGroup: this.logGroup, streamPrefix: 'ecs' });

    const appContainer = taskDefinition.addContainer('app', {
      ...containerDefinition,
      cpu: (meshEnabled) ? Math.round(cpu * appCpuRate) : undefined,
      memoryReservationMiB: (meshEnabled) ? Math.round(memory * appMemRate) : undefined,
      essential: true,
      logging,
    });
    appContainer.addUlimits({ name: ecs.UlimitName.NOFILE, softLimit: 65536, hardLimit: 65536 });

    this.ecsService = new ecs.FargateService(this, 'Svc', {
      cluster,
      taskDefinition,
      circuitBreaker: { rollback: true },
      enableECSManagedTags: true,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      //capacityProviderStrategies: [
      //  { capacityProvider: 'FARGATE', base: 1, weight: 1 },
      //  { capacityProvider: 'FARGATE_SPOT', base: 0, weight: 0 },
      //],
    });

    this.cloudMapService = this.ecsService.enableCloudMap({
      name: serviceName,
      dnsRecordType: servicediscovery.DnsRecordType.SRV,
      container: appContainer,
      dnsTtl: cdk.Duration.seconds(10),
    });
    (this.cloudMapService.node.defaultChild as servicediscovery.CfnService).addPropertyOverride('DnsConfig.DnsRecords.1', { Type: 'A', TTL: 10 });

    this.forceDeployFunction = new targets.LambdaFunction(new NodejsFunction(this, 'ForceDeployFunction', {
      description: 'Supabase - Force deploy ECS service function',
      entry: 'src/functions/ecs-force-deploy.ts',
      runtime: lambda.Runtime.NODEJS_16_X,
      architecture: lambda.Architecture.ARM_64,
      environment: {
        ECS_CLUSTER_NAME: cluster.clusterName,
        ECS_SERVICE_NAME: this.ecsService.serviceName,
      },
      initialPolicy: [new iam.PolicyStatement({
        actions: ['ecs:UpdateService'],
        resources: [this.ecsService.serviceArn],
      })],
    }));

    if (autoScalingEnabled) {
      const autoScaling = this.ecsService.autoScaleTaskCount({ maxCapacity: 100 });
      autoScaling.scaleOnCpuUtilization('ScaleOnCpu', {
        targetUtilizationPercent: 50,
        scaleInCooldown: cdk.Duration.seconds(60),
        scaleOutCooldown: cdk.Duration.seconds(60),
      });
    }

    if (meshEnabled) {
      this.virtualNode = new appmesh.VirtualNode(this, 'VirtualNode', {
        virtualNodeName: id,
        serviceDiscovery: appmesh.ServiceDiscovery.cloudMap(this.ecsService.cloudMapService!),
        listeners: [appmesh.VirtualNodeListener.http({
          port: this.listenerPort,
          connectionPool: { maxConnections: 1024, maxPendingRequests: 1024 },
        })],
        accessLog: appmesh.AccessLog.fromFilePath('/dev/stdout'),
        mesh: mesh!,
      });

      this.virtualService = new appmesh.VirtualService(this, 'VirtualService', {
        virtualServiceName: `${serviceName}.${cluster.defaultCloudMapNamespace!.namespaceName}`,
        virtualServiceProvider: appmesh.VirtualServiceProvider.virtualNode(this.virtualNode),
      });

      taskDefinition.taskRole.addManagedPolicy({ managedPolicyArn: 'arn:aws:iam::aws:policy/AWSAppMeshEnvoyAccess' });
      taskDefinition.taskRole.addManagedPolicy({ managedPolicyArn: 'arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess' });

      const proxyContainer = taskDefinition.addContainer('envoy', {
        image: ecs.ContainerImage.fromRegistry('public.ecr.aws/appmesh/aws-appmesh-envoy:v1.22.2.1-prod'),
        user: '1337',
        cpu: Math.round(cpu * envoyCpuRate),
        memoryReservationMiB: Math.round(memory * envoyMemRate),
        essential: true,
        healthCheck: {
          command: ['CMD-SHELL', 'curl -s http://localhost:9901/server_info | grep state | grep -q LIVE'],
          interval: cdk.Duration.seconds(5),
          timeout: cdk.Duration.seconds(2),
          startPeriod: cdk.Duration.seconds(10),
          retries: 3,
        },
        environment: {
          APPMESH_VIRTUAL_NODE_NAME: `mesh/${mesh!.meshName}/virtualNode/${this.virtualNode.virtualNodeName}`,
          ENVOY_ADMIN_ACCESS_LOG_FILE: '/dev/null',
          ENABLE_ENVOY_XRAY_TRACING: '1',
          XRAY_SAMPLING_RATE: '1.00',
        },
        readonlyRootFilesystem: false, // Envoy create a config file at bootstraping.
        logging,
      });
      proxyContainer.addUlimits({ name: ecs.UlimitName.NOFILE, hardLimit: 1024000, softLimit: 1024000 });

      appContainer.addContainerDependencies({
        container: proxyContainer,
        condition: ecs.ContainerDependencyCondition.HEALTHY,
      });

      taskDefinition.addContainer('otel-collector', {
        image: ecs.ContainerImage.fromRegistry('public.ecr.aws/aws-observability/aws-otel-collector:v0.21.1'),
        command: ['--config=/etc/ecs/ecs-default-config.yaml'],
        user: '1337',
        cpu: Math.round(cpu * otelCpuRate),
        memoryReservationMiB: Math.round(memory * otelMemRate),
        essential: true,
        //healthCheck: {
        //  command: ['CMD', '/xray', '--version', '||', 'exit 1'], // https://github.com/aws/aws-xray-daemon/issues/9
        //  interval: cdk.Duration.seconds(5),
        //  timeout: cdk.Duration.seconds(2),
        //  startPeriod: cdk.Duration.seconds(10),
        //  retries: 3,
        //},
        readonlyRootFilesystem: true,
        logging,
      });

    }

  }

  //addContainer(id: string, props: ecs.ContainerDefinitionOptions) {
  //  const container = this.ecsService.taskDefinition.addContainer(id, {
  //    ...props,
  //    logging: new ecs.AwsLogDriver({ logGroup: this.logGroup, streamPrefix: 'ecs' }),
  //  });
  //  return container;
  //}

  addNetworkLoadBalancer() {
    const vpc = this.ecsService.cluster.vpc;
    const vpcInternal = ec2.Peer.ipv4(vpc.vpcCidrBlock);
    const healthCheckPort = ec2.Port.tcp(this.ecsService.taskDefinition.defaultContainer!.portMappings.slice(-1)[0].containerPort); // 2nd port
    this.ecsService.connections.allowFrom(vpcInternal, healthCheckPort, 'NLB healthcheck');

    const targetGroup = new elb.NetworkTargetGroup(this, 'TargetGroup', {
      port: this.listenerPort,
      targets: [
        this.ecsService.loadBalancerTarget({ containerName: 'app' }),
      ],
      healthCheck: {
        port: healthCheckPort.toString(),
        interval: cdk.Duration.seconds(10),
      },
      deregistrationDelay: cdk.Duration.seconds(30),
      preserveClientIp: true,
      vpc,
    });
    const loadBalancer = new elb.NetworkLoadBalancer(this, 'LoadBalancer', { internetFacing: true, vpc });
    loadBalancer.addListener('Listener', {
      port: 80,
      defaultTargetGroups: [targetGroup],
    });
    return loadBalancer;
  }

  addBackend(backend: SupabaseService) {
    this.ecsService.connections.allowTo(backend.ecsService, ec2.Port.tcp(backend.listenerPort));
    if (typeof backend.virtualService != 'undefined') {
      this.virtualNode?.addBackend(appmesh.Backend.virtualService(backend.virtualService));
    }
  }

  addDatabaseBackend(backend: SupabaseDatabase) {
    this.ecsService.connections.allowToDefaultPort(backend);
    if (typeof backend.virtualService != 'undefined') {
      this.virtualNode?.addBackend(appmesh.Backend.virtualService(backend.virtualService));
    }
    this.ecsService.node.defaultChild?.node.addDependency(backend.node.findChild('Instance1'));

    new events.Rule(this, 'DatabaseSecretRotated', {
      description: `Supabase - Force deploy ${this.node.id}, when DB secret rotated`,
      eventPattern: {
        source: ['aws.secretsmanager'],
        detail: {
          eventName: ['RotationSucceeded'],
          additionalEventData: {
            SecretId: [backend.secret?.secretArn],
          },
        },
      },
      targets: [this.forceDeployFunction],
    });
  }

  addExternalBackend(backend: SupabaseServiceBase) {
    if (typeof backend.virtualService != 'undefined') {
      this.virtualNode?.addBackend(appmesh.Backend.virtualService(backend.virtualService));
    }
  }
}
