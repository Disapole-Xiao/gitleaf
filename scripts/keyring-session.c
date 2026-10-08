#include <linux/keyctl.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 2) {
        fputs("Missing command.\n", stderr);
        return 2;
    }
    if (syscall(SYS_keyctl, KEYCTL_JOIN_SESSION_KEYRING, 0, 0, 0, 0) < 0) {
        perror("Could not create a Linux keyring session");
        return 1;
    }
    execvp(argv[1], argv + 1);
    perror("Could not launch keyring worker");
    return 1;
}
