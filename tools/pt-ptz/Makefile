CC ?= cc
CFLAGS ?= -Wall -Wextra -O2 -Wno-unused-parameter
FRAMEWORKS = -framework CoreFoundation -framework IOKit -framework CoreMIDI

pt-ptz: pt-ptz.c
	$(CC) $(CFLAGS) -o $@ $< $(FRAMEWORKS)

clean:
	rm -f pt-ptz

.PHONY: clean
