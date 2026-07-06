def outer(x: int) -> int:
    def inner(y: int) -> int:
        return y * 2
    return inner(x)

class A:
    class Inner:
        def deep_method(self):
            pass

    def method(self):
        def local_helper():
            pass
        return local_helper

if True:
    def conditional_fn():
        pass

__all__ = ["outer", "A"]
