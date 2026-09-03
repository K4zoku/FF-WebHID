#!/bin/sh

if [ ! -e /dev/uhid ]; then
    printf '%s\n' 'UHID unavailable'
    printf '%s\n' 'Host guidance: load the host uhid module and recreate the container with /dev/uhid plus hidraw access.'
    exit 0
fi

if [ ! -c /dev/uhid ] || [ ! -r /dev/uhid ] || [ ! -w /dev/uhid ]; then
    printf '%s\n' 'UHID present but not writable'
    printf '%s\n' 'Host guidance: apply manifests/99-webhid-e2e.rules and pass the host webhid group or matching device permissions into the container.'
    exit 0
fi

printf '%s\n' 'UHID usable'
printf '%s\n' 'Note: E2E also needs the hidraw nodes created by webhid-mock to be visible and writable.'
