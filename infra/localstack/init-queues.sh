#!/bin/sh
set -eu

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true
awslocal sqs create-queue --queue-name wager-events.fifo --attributes FifoQueue=true
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes '{"FifoQueue":"true","VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"10","RedrivePolicy":"{\"deadLetterTargetArn\":\"arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo\",\"maxReceiveCount\":\"5\"}"}'
