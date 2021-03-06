var _ = require('lodash');
var bluebird_retry = require('bluebird-retry');
var common = require('../lib/common');
var expect = require('chai').expect;
var uuid = require('uuid');
var Promise = require('bluebird');

var broker = process.env.NODE_KAFKA_NATIVE_BROKER || 'localhost:9092';
var default_timeout = 30000;
var default_retry_options = { max_tries: 10, interval: 1000 };

// Tests below assume auto topic creation is enabled in the broker.
var gen_topic_name = function() {
    return 'node-kafka-native-test-' + uuid.v4();
}

var retry = function(func, retry_options) {
    retry_options = retry_options || default_retry_options;
    return bluebird_retry(func, retry_options);
}

function create_pair(topic_name, consumer_recv_cb) {
    return Promise.try(function() {
        var producer = new common.RawProducer({
            driver_options: {
                'metadata.broker.list': broker,
            },
        });

        var consumer = new common.RawConsumer({
            topic: topic_name,
            recv_cb: consumer_recv_cb,
            driver_options: {
                'metadata.broker.list': broker,
            },
        });

        return Promise.map([producer, consumer], function(handle) {
            return common.fetch_partition_count(handle, topic_name);
        })
        .then(function(arr) {
            expect(arr[0]).equals(arr[1]);
            return {
                producer: producer,
                consumer: consumer,
                num_partitions: arr[0],
            };
        });
    });
}


describe('raw handle api tests', function() {
    this.timeout(default_timeout);

    it('should create new producer', function() {
        var topic_name = gen_topic_name();
        var producer = new common.RawProducer({
            driver_options: {
                'metadata.broker.list': broker,
            },
        });

        // Use common.fetch_partition_count to verify that rdkafka
        // structures have been setup.
        return common.fetch_partition_count(producer, topic_name)
        .then(function(npartitions) {
            // If the below fails, ensure your kafka broker is configured to
            // with a 'num.partitions' count greater than 1.
            expect(npartitions).gt(1);
            producer.stop();
        });
    });

    it('should create new consumer', function() {
        var topic_name = gen_topic_name();
        var consumer = new common.RawConsumer({
            topic: topic_name,
            recv_cb: function() {},
            driver_options: {
                'metadata.broker.list': broker,
            },
        });
        return common.fetch_partition_count(consumer, topic_name)
        .then(function() {
            consumer.stop();
        });
    });

    it('should produce and consume messages', function() {
        var topic_name = gen_topic_name();
        var received_messages = {};

        var recv_cb = function(messages) {
            _.each(messages, function(kmsg) {
                if (received_messages[kmsg.partition] === undefined) {
                    received_messages[kmsg.partition] = [];
                }
                received_messages[kmsg.partition].push(kmsg);
            });
        };

        var producer, consumer, num_partitions;
        return create_pair(topic_name, recv_cb)
        .then(function(res) {
            producer = res.producer;
            consumer = res.consumer;
            num_partitions = res.num_partitions;

            return Promise.each(_.range(num_partitions), function(partition) {
                producer.send(topic_name, partition, [String(partition)]);
            });
        })
        .then(function() {
            var partitions = {};
            _.each(_.range(num_partitions), function(p) { partitions[p] = 0; });

            consumer.start(partitions)

            return retry(function(cancel) {
                expect(producer.outq_length()).equals(0);
                expect(_.keys(received_messages).length).equals(num_partitions);
                _.each(_.range(num_partitions), function(partition) {
                    var msgs = received_messages[partition];
                    expect(msgs).to.exist;
                    expect(msgs.length).equals(1);
                    var msg = msgs[0];
                    expect(msg.payload).equals(String(partition));
                    expect(msg.partition).equals(Number(partition));
                    expect(msg.offset).equals(0);
                    expect(msg.topic).equals(topic_name);
                    expect(msg.key).to.not.exist;
                });
            });
        })
        .then(function() {
            producer.stop();
            consumer.stop();
        });
    });

    it('consume should honor pause and resume', function() {
        var topic_name = gen_topic_name();
        var paused = false;
        var recv_while_paused = false;
        var received_messages = {};

        var recv_cb = function(messages) {
            if (paused) {
                recv_while_paused = true;
            }

            _.each(messages, function(kmsg) {
                if (received_messages[kmsg.partition] === undefined) {
                    received_messages[kmsg.partition] = [];
                }
                received_messages[kmsg.partition].push(kmsg);
            });
        };

        var producer, consumer, num_partitions;
        return create_pair(topic_name, recv_cb)
        .then(function(res) {
            producer = res.producer;
            consumer = res.consumer;
            num_partitions = res.num_partitions;

            var partitions = {};
            _.each(_.range(num_partitions), function(p) { partitions[p] = 0; });

            consumer.start(partitions)
            paused = true;
            consumer.pause();

            return Promise.each(_.range(num_partitions), function(partition) {
                producer.send(topic_name, partition, [String(partition)]);
            })
            // wait for few seconds
            .delay(5000);
        })
        .then(function() {
            expect(recv_while_paused).equals(false);
            paused = false;
            consumer.resume();

            // the above messages should already be sitting
            // in rdkafka's consume queue, so dont retry
            // for long.
            return bluebird_retry(function(cancel) {
                expect(_.keys(received_messages).length).equals(num_partitions);
                _.each(_.range(num_partitions), function(partition) {
                    var msgs = received_messages[partition];
                    expect(msgs).to.exist;
                    expect(msgs.length).equals(1);
                    var msg = msgs[0];
                    expect(msg.payload).equals(String(partition));
                    expect(msg.partition).equals(Number(partition));
                    expect(msg.offset).equals(0);
                    expect(msg.topic).equals(topic_name);
                    expect(msg.key).to.not.exist;
                });
            }, {max_tries: 2, interval: 1000});
        })
        .then(function() {
            producer.stop();
            consumer.stop();
        });
    });

    it('should allow utf8 messages through', function() {
        var topic_name = gen_topic_name();
        var teststr = "私はガラスを.食べられ.ます。それは私.を傷つ.けません";
        var received_messages = {};

        var recv_cb = function(messages) {
            _.each(messages, function(kmsg) {
                if (received_messages[kmsg.partition] === undefined) {
                    received_messages[kmsg.partition] = [];
                }
                received_messages[kmsg.partition].push(kmsg);
            });
        };

        var producer, consumer, num_partitions;
        return create_pair(topic_name, recv_cb)
        .then(function(res) {
            producer = res.producer;
            consumer = res.consumer;
            num_partitions = res.num_partitions;

            return Promise.each(_.range(num_partitions), function(partition) {
                producer.send(topic_name, partition, [teststr]);
            });
        })
        .then(function() {
            var partitions = {};
            _.each(_.range(num_partitions), function(p) { partitions[p] = 0; });

            consumer.start(partitions)

            return retry(function(cancel) {
                expect(_.keys(received_messages).length).equals(num_partitions);
                _.each(_.range(num_partitions), function(partition) {
                    var msgs = received_messages[partition];
                    expect(msgs).to.exist;
                    expect(msgs.length).equals(1);
                    var msg = msgs[0];
                    expect(msg.payload).equals(teststr);
                    expect(msg.partition).equals(Number(partition));
                    expect(msg.offset).equals(0);
                    expect(msg.topic).equals(topic_name);
                    expect(msg.key).to.not.exist;
                });
            });
        })
        .then(function() {
            producer.stop();
            consumer.stop();
        });
    });

});
